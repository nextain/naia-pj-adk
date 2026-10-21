#!/usr/bin/env bash
# Follow an upstream branch in a dedicated, read-only checkout.
#
# Documents and working tree only. This moves a detached checkout that people
# and dashboards read. It never touches a branch someone works on, and it is
# not how pinned policy or code versions are updated: those stay pinned and
# move through a reviewed pull request.
#
# Each run: fetch <remote>/<branch>; if the checkout has no local changes,
# detach it at the fetched commit; otherwise skip and record why. Every run
# writes one JSON line per step to <log-dir>/YYYYMMDD.log with the commit
# before and after, which is the rollback reference.
#
# Usage: docs-follow.sh --checkout DIR [--remote NAME] [--branch NAME] [--log-dir DIR]
# The same settings can come from the environment:
#   DOCS_FOLLOW_CHECKOUT   checkout to move (required; a dedicated worktree)
#   DOCS_FOLLOW_REMOTE     remote name (default: origin)
#   DOCS_FOLLOW_BRANCH     upstream branch (default: main)
#   DOCS_FOLLOW_LOG_DIR    log folder (default: $XDG_STATE_HOME/naia-docs-follow)
#   DOCS_FOLLOW_LOG_DAYS   days of logs to keep (default: 14)
#   DOCS_FOLLOW_DEBUG      1 records fetch output on every run (default: 1)
#   DOCS_FOLLOW_TIMEOUT    fetch timeout in seconds (default: 120)
#
# Exit codes: 0 followed or already current, 2 usage, 3 skipped because the
# checkout has local changes, 4 refused because the checkout is on a branch,
# any other non-zero value is the failing git command's status.
set -u

CHECKOUT=${DOCS_FOLLOW_CHECKOUT:-}
REMOTE=${DOCS_FOLLOW_REMOTE:-origin}
BRANCH=${DOCS_FOLLOW_BRANCH:-main}
LOG_DIR=${DOCS_FOLLOW_LOG_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/naia-docs-follow}
LOG_DAYS=${DOCS_FOLLOW_LOG_DAYS:-14}
DEBUG=${DOCS_FOLLOW_DEBUG:-1}
TIMEOUT=${DOCS_FOLLOW_TIMEOUT:-120}

usage() {
  echo "usage: docs-follow.sh --checkout DIR [--remote NAME] [--branch NAME] [--log-dir DIR]" >&2
  exit 2
}

while [ $# -gt 0 ]; do
  case $1 in
    --checkout|--remote|--branch|--log-dir) [ $# -ge 2 ] || usage ;;
    -h|--help) usage ;;
    *) echo "docs-follow: unknown argument: $1" >&2; usage ;;
  esac
  case $1 in
    --checkout) CHECKOUT=$2 ;;
    --remote) REMOTE=$2 ;;
    --branch) BRANCH=$2 ;;
    --log-dir) LOG_DIR=$2 ;;
  esac
  shift 2
done
[ -n "$CHECKOUT" ] && [ -n "$REMOTE" ] && [ -n "$BRANCH" ] && [ -n "$LOG_DIR" ] || usage

mkdir -p "$LOG_DIR" || exit 2
LOG=$LOG_DIR/$(date +%Y%m%d).log

json() {
  local s=$1
  s=${s:0:2000}
  s=${s//\\/\\\\}; s=${s//\"/\\\"}
  s=${s//$'\n'/\\n}; s=${s//$'\r'/\\r}; s=${s//$'\t'/\\t}
  printf '"%s"' "$s"
}
log() {
  printf '{"t":"%s","checkout":%s,"step":"%s","msg":%s}\n' \
    "$(date -Iseconds)" "$(json "$CHECKOUT")" "$1" "$(json "$2")" >> "$LOG"
}

find "$LOG_DIR" -name '*.log' -mtime +"$LOG_DAYS" -delete 2>/dev/null

TRACKING=refs/remotes/$REMOTE/$BRANCH
before=$(git -C "$CHECKOUT" rev-parse HEAD 2>&1)

if git -C "$CHECKOUT" symbolic-ref -q HEAD >/dev/null 2>&1; then
  log error "checkout is on a branch; follow only a detached, dedicated worktree"
  exit 4
fi

run_fetch() {
  if command -v timeout >/dev/null 2>&1; then
    timeout "$TIMEOUT" git -C "$CHECKOUT" fetch --quiet "$REMOTE" "+refs/heads/$BRANCH:$TRACKING"
  else
    git -C "$CHECKOUT" fetch --quiet "$REMOTE" "+refs/heads/$BRANCH:$TRACKING"
  fi
}
out=$(run_fetch 2>&1); rc=$?
[ "$DEBUG" != 0 ] && log fetch "rc=$rc $out"
if [ $rc -ne 0 ]; then log error "fetch failed rc=$rc $out"; exit $rc; fi

if [ -n "$(git -C "$CHECKOUT" status --porcelain 2>&1)" ]; then
  log skip "checkout has local changes; left at $before"
  exit 3
fi

out=$(git -C "$CHECKOUT" checkout --detach --quiet "$TRACKING" 2>&1); rc=$?
after=$(git -C "$CHECKOUT" rev-parse HEAD 2>&1)
log done "rc=$rc $before -> $after $out"
exit $rc
