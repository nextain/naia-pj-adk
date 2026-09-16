#!/usr/bin/env python3
"""Offline CLI regressions for closed issue / tracker / thread divergence."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


class ClosureAudit(unittest.TestCase):
    def audit(self, state, github, archived=False, closed_by=None):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            item = {'key': 'example#1', 'state': state, 'threadId': 'thread-fixture'}
            if closed_by:
                item['closedBy'] = closed_by
            thread = {'id': 'thread-fixture', 'parent_id': 'channel-fixture',
                      'name': 'example#1'}
            for name, data in {
                'tracker.json': {'version': 1, 'items': [item]},
                'session.json': {'discord': {'bindings': [{'threadId': thread['id']}]}},
                'active.json': {'threads': [] if archived else [thread]},
                'archived.json': {'threads': [thread] if archived else []},
            }.items():
                (root / name).write_text(json.dumps(data), encoding='utf-8')
            (root / 'issues.tsv').write_text(f'example#1\t{github}\n', encoding='utf-8')
            before = {p.name: p.read_bytes() for p in root.iterdir()}
            result = subprocess.run(
                [sys.executable, str(Path(__file__).with_name('audit-report.py')),
                 str(root / 'tracker.json'), str(root / 'session.json'),
                 str(root), 'channel-fixture'],
                capture_output=True, text=True, encoding='utf-8', timeout=10)
            self.assertEqual(before, {p.name: p.read_bytes() for p in root.iterdir()})
            self.assertEqual(result.stderr, '')
            return result

    def test_completed_item_with_closed_issue_and_active_thread_is_a_finding(self):
        result = self.audit('completed', 'CLOSED')
        self.assertEqual(result.returncode, 1)
        self.assertIn('종료 후속 확인 필요', result.stdout)

    def test_closed_alias_still_checks_thread(self):
        result = self.audit('closed', 'CLOSED')
        self.assertEqual(result.returncode, 1)
        self.assertIn('종료 후속 확인 필요', result.stdout)

    def test_archived_completion_is_consistent(self):
        result = self.audit('completed', 'CLOSED', archived=True)
        self.assertEqual(result.returncode, 0)
        self.assertIn('불일치 없음', result.stdout)

    def test_open_work_with_active_thread_is_consistent(self):
        result = self.audit('awaiting_user_verification', 'OPEN')
        self.assertEqual(result.returncode, 0)

    def test_intentionally_resolved_followup_does_not_close_open_issue(self):
        result = self.audit('completed', 'OPEN', closed_by='manual_cleanup')
        self.assertEqual(result.returncode, 0)
        self.assertIn('후속 조치는 정리됨', result.stdout)


if __name__ == '__main__':
    unittest.main()
