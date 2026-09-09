import json
import multiprocessing
from pathlib import Path
import tempfile
import unittest
from issue_lifecycle import (resolve_issue_key, project_execution, may_dispatch,
                             is_conversation_message, update_tracker)

ITEM = {"key": "example/service#7", "state": "dispatched", "threadId": "thread-a"}
REPOS = ["example/service", "example/tools"]


def increment(path):
    for _ in range(15):
        update_tracker(path, lambda data: {"count": data["count"] + 1})


class LifecycleTests(unittest.TestCase):
    def resolve(self, text, items=None, thread=None):
        return resolve_issue_key(text, items or [ITEM], REPOS, thread)

    def job(self, state="completed", **extra):
        return dict(id="job-a", state=state, updatedAt="2026-01-01T00:00:00Z",
                    issueKey=ITEM["key"], **extra)

    def test_binding_wins_cross_reference(self):
        self.assertEqual(self.resolve("example/tools#8", thread="thread-a"), ITEM["key"])

    def test_disallowed_existing_binding_cannot_fall_through(self):
        self.assertIsNone(self.resolve("example/service#7", [dict(ITEM, key="unknown/repo#7")], "thread-a"))
        self.assertIsNone(self.resolve("example/service#7", [ITEM, dict(ITEM, key="unknown/repo#7")], "thread-a"))

    def test_timestamp_precision_orders_chronologically(self):
        older = self.job("failed")
        newer = dict(self.job(), updatedAt="2026-01-01T00:00:00.500Z")
        self.assertEqual(project_execution(ITEM, [older, newer])["executionState"], "completed")

    def test_explicit_url(self):
        self.assertEqual(self.resolve("https://github.com/example/tools/issues/7 and #7"), "example/tools#7")

    def test_ambiguous_bare_number(self):
        self.assertIsNone(self.resolve("#7", [ITEM, dict(ITEM, key="example/tools#7")]))
        self.assertIsNone(self.resolve("#7 and #8"))
        self.assertEqual(self.resolve("#7"), ITEM["key"])

    def test_unknown_repo_and_multiple_explicit(self):
        self.assertIsNone(self.resolve("unknown/repo#7"))
        self.assertIsNone(self.resolve("example/service#7 example/tools#7"))
        self.assertIsNone(self.resolve("#70"))

    def test_conflicting_binding_fails_closed(self):
        self.assertIsNone(self.resolve("example/service#7", [ITEM, dict(ITEM, key="example/tools#7")], "thread-a"))

    def test_case_normalization_and_alias_binding(self):
        self.assertEqual(self.resolve("EXAMPLE/SERVICE#7"), ITEM["key"])
        self.assertEqual(self.resolve("", [dict(ITEM, duplicateThreadIds=["thread-b"])], "thread-b"), ITEM["key"])

    def test_scheduler_excludes_parent_auxiliary_and_human_wait(self):
        self.assertTrue(may_dispatch(ITEM, "parent"))
        for change in [dict(threadId="parent"), dict(key="thread:helper"), dict(recordKind="auxiliary"), dict(state="parked"), dict(state="awaiting_owner_approval"), dict(threadArchived=True)]:
            self.assertFalse(may_dispatch(dict(ITEM, **change), "parent"))

    def test_real_message_types_only(self):
        for event in [0, 19]:
            self.assertTrue(is_conversation_message({"type": event}))
        for event in [1, 18, None, "0", False]:
            self.assertFalse(is_conversation_message({"type": event}))

    def test_worker_completion_does_not_close_issue(self):
        item = dict(ITEM, githubState="OPEN")
        result = project_execution(item, [self.job()])
        self.assertEqual(result["state"], "followup_pending")
        self.assertEqual(result["githubState"], "OPEN")
        self.assertEqual(item["state"], "dispatched")

    def test_preserve_deliberate_resolution_and_human_wait(self):
        for state in ["completed", "closed", "parked", "awaiting_user_verification", "awaiting_owner_approval"]:
            self.assertEqual(project_execution(dict(ITEM, state=state), [self.job()])["state"], state)

    def test_active_job_precedes_newer_terminal(self):
        active = self.job("running"); later = dict(self.job(), updatedAt="2026-01-02T00:00:00Z")
        result = project_execution(dict(ITEM, executionFinishedAt="old"), [later, active])
        self.assertEqual(result["executionState"], "running")
        self.assertNotIn("executionFinishedAt", result)

    def test_old_identity_requires_same_channel(self):
        item = dict(ITEM, previousIssueKeys=["example/tools#7"])
        unrelated = dict(self.job(), issueKey="example/tools#7", channelId="thread-other")
        self.assertEqual(project_execution(item, [unrelated]), item)
        unrelated["channelId"] = "thread-a"
        self.assertEqual(project_execution(item, [unrelated])["state"], "followup_pending")

    def test_conflicting_job_key_cannot_use_channel_fallback(self):
        job = dict(self.job(), issueKey="example/tools#7", channelId="thread-a")
        self.assertEqual(project_execution(ITEM, [job]), ITEM)

    def test_failed_execution(self):
        self.assertEqual(project_execution(ITEM, [self.job("failed")])["state"], "failed_with_alert")

    def test_schema_accepts_projection_fields(self):
        schema = json.loads((Path(__file__).resolve().parents[2] / "schemas/followups.schema.json").read_text())
        fields = schema["$defs"]["item"]["properties"]
        for state in ["queued", "running", "completed", "failed", "interrupted"]:
            result = project_execution(ITEM, [self.job(state)])
            self.assertLessEqual(set(result), set(fields))
            self.assertIn(result["state"], fields["state"]["enum"])
            self.assertIn(result["executionState"], fields["executionState"]["enum"])

    def test_atomic_failure_preserves_original(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "tracker.json"; path.write_text('{"count": 0}')
            with self.assertRaises(TypeError):
                update_tracker(path, lambda _: {"invalid": object()})
            self.assertEqual(json.loads(path.read_text()), {"count": 0})
            self.assertEqual(sorted(p.name for p in path.parent.iterdir()), ["tracker.json", "tracker.json.lock"])

    def test_concurrent_writers_do_not_lose_updates(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "tracker.json"; path.write_text('{"count": 0}')
            workers = [multiprocessing.Process(target=increment, args=(path,)) for _ in range(4)]
            for worker in workers: worker.start()
            for worker in workers:
                worker.join(10)
                self.assertEqual(worker.exitcode, 0)
            self.assertEqual(json.loads(path.read_text())["count"], 60)


if __name__ == "__main__":
    unittest.main()
