"""Offline project adapter primitives; no Discord, database or authority access."""
import copy
from datetime import datetime
import fcntl
import json
import os
from pathlib import Path
import re
import tempfile

KEY = re.compile(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+#[1-9][0-9]*")
REFERENCE = re.compile(r"https://github\.com/([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)/issues/([1-9][0-9]*)(?![0-9])|(?<![\w/.-])([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)#([1-9][0-9]*)(?![0-9])")
BARE = re.compile(r"(?<![\w/.-])#([1-9][0-9]*)(?![0-9])")
ACTIVE = {"queued", "running"}
TERMINAL = {"completed", "failed", "interrupted"}
PROTECTED = {"completed", "closed", "parked", "awaiting_user_verification", "awaiting_owner_approval"}


def is_issue_key(value):
    return isinstance(value, str) and KEY.fullmatch(value) is not None


def thread_ids(item):
    return {value for value in [item.get("threadId"), *item.get("duplicateThreadIds", [])] if value}


def resolve_issue_key(text, items, repositories, thread_id=None):
    """Trusted binding wins; otherwise resolve only unambiguous allowed references."""
    allowed = {repo.lower() for repo in repositories}
    def accepted(key):
        return is_issue_key(key) and key.split("#")[0].lower() in allowed
    bound_items = [item for item in items if thread_id and thread_id in thread_ids(item)]
    if bound_items:
        if any(not accepted(item.get("key")) for item in bound_items):
            return None
        bound = {item["key"].lower() for item in bound_items}
        return next(iter(bound)) if len(bound) == 1 else None
    explicit = set()
    def collect(match):
        repo, number = (match[1], match[2]) if match[1] else (match[3], match[4])
        explicit.add(f"{repo.lower()}#{number}")
        return " "
    remainder = REFERENCE.sub(collect, text)
    # An unknown explicit repository must never become a default repository.
    if explicit:
        return next(iter(explicit)) if len(explicit) == 1 and accepted(next(iter(explicit))) else None
    numbers = set(BARE.findall(remainder))
    candidates = {item["key"].lower() for item in items
                  if accepted(item.get("key")) and item["key"].split("#")[1] in numbers}
    return next(iter(candidates)) if len(numbers) == 1 and len(candidates) == 1 else None


def may_dispatch(item, parent_channel_id):
    return (is_issue_key(item.get("key")) and item.get("recordKind", "issue") == "issue"
            and bool(item.get("threadId")) and item["threadId"] != parent_channel_id
            and item.get("state") not in PROTECTED and not item.get("threadArchived", False))


def is_conversation_message(message):
    # Adapters must supply the Discord type; unknown events do not discharge replies.
    return type(message.get("type")) is int and message["type"] in (0, 19)


def project_execution(item, jobs):
    """Project normalized job snapshots; never infer GitHub closure or delivery."""
    result = copy.deepcopy(item)
    if not is_issue_key(item.get("key")):
        return result
    key = item["key"].lower()
    aliases = {value.lower() for value in item.get("previousIssueKeys", []) if is_issue_key(value)}
    ids = thread_ids(item)
    def matches(job):
        issue = (job.get("issueKey") or "").lower()
        channel_matches = job.get("channelId") in ids
        return issue == key or (channel_matches and (not issue or issue in aliases))
    relevant = [job for job in jobs if matches(job) and job.get("state") in ACTIVE | TERMINAL]
    if not relevant:
        return result
    # updatedAt is a normalized UTC ISO timestamp supplied by the adapter.
    job = max(relevant, key=lambda job: (job["state"] in ACTIVE, datetime.fromisoformat(job["updatedAt"].replace("Z", "+00:00")), job["id"]))
    result.update(executionState=job["state"], executionJobId=job["id"], executionUpdatedAt=job["updatedAt"])
    result.pop("executionFinishedAt", None)
    if job["state"] in TERMINAL:
        result["executionFinishedAt"] = job["updatedAt"]
    if item.get("state") not in PROTECTED and not item.get("closedBy"):
        result["state"] = ("dispatched" if job["state"] in ACTIVE else
                           "followup_pending" if job["state"] == "completed" else "failed_with_alert")
    return result


def update_tracker(path, transform):
    """Serialize the entire read/modify/write; all writers must use this lock.

    POSIX local filesystems only. The callback returns the complete JSON object.
    Exceptions preserve the old file. This is not a distributed lock.
    """
    path = Path(path)
    with open(str(path) + ".lock", "a", encoding="utf-8") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        with path.open(encoding="utf-8") as source:
            result = transform(json.load(source))
        fd, temporary = tempfile.mkstemp(prefix=path.name + ".", dir=path.parent)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as target:
                json.dump(result, target, ensure_ascii=False, indent=2)
                target.write("\n")
                target.flush()
                os.fsync(target.fileno())
            os.replace(temporary, path)
            directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
        return result
