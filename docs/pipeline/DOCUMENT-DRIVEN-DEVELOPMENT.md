# Document-driven development

Scope: common
Status: draft
Related contract: `.agents/context/development-method.yaml` (artifacts, planning and implementation order, scope lock, receipts, QC). [OVERVIEW.ko.md](OVERVIEW.ko.md) covers the feature pipeline in the same terms.

This document describes how a team and its agents work when documents are the
canonical record. It names roles, not people, models, accounts or machines. An
instance fills in who plays each role in its own repository.

## 1. Summary

**Documents are canonical. Work reads documents, and results return to documents.**

```text
Owner ⇄ Coordinator (edit documents together, leave notes, talk)
        │  document = verbatim request trace, goals and requirements (PC/SP/UC/RQ/FE),
        │             approvals, task rows, verification
        ▼
  Executor / coordinator session ── reads a task row and delegates the problem,
        │                           goal and acceptance criteria to a subagent
        │                           (implementer or reviewer), with a periodic watchdog
        ▼
  Results and evidence ── return to the same row of the work document:
        │                 status, evidence links, spec chain (UT/IT/E2E/QC)
        ▼
  Owner checks the document → next task
```

Agents work in four layers, counted from the bottom: layer 1 sensor (repetitive
work), layer 2 member (implementation and review), layer 3 lead (coordination,
working with the owner), layer 4 advisor. Work is handled at the lowest layer
that can do it, and only what that layer cannot solve goes up (section 4.1).

Roles used below:

| Role | Does |
|---|---|
| Owner | Sets goals, approves plans, decides what only a person can decide |
| Coordinator | Talks with the owner, records requests verbatim, delegates, watches, judges results |
| Implementer | Analyses, designs and implements one task row |
| Reviewer | Reviews a result independently; never the same model or session as the implementer |
| Executor | Picks ready rows, launches subagents, writes status back (a script or the coordinator) |
| Sensor | Watches inboxes, notes and running jobs, and wakes the coordinator |

## 2. Document structure

All development documents live under one documents root (for example
`docs/developer/`). Every folder has an `index.md` that links its children in
reading order.

| Layer | Location | Holds | Edited by |
|---|---|---|---|
| Product | `product/<product>/index.md` | Product goal and the entry to its requirements (RQ), use cases (UC) and decisions (D) | Owner, coordinator |
| Requirements and decisions | `product/<product>/*-rq.md`, `*-decisions.md` | One number per requirement, one number per decision | Owner decides, coordinator records |
| Work document | `product/<product>/work/<number>-<name>.md` | One unit of user value. Template in section 3 | Owner and coordinator; the status column belongs to the executor |
| Evidence | `product/<product>/work/<number>-<name>/` | Result reports, review results, screenshots and recordings, diagnostics | Tasks and the executor only |
| Principles | `guides/`, `pipeline/` | Shared rules: debugging and logging, review, refactoring and complexity gates, sensors, multi-account operation | Owner, coordinator |

### Common and instance documents

| Kind | Holds | Written | Lives in |
|---|---|---|---|
| Common | Concepts and procedures that are the same in any company or machine: the four layers, normal and urgent paths, the work document template, how sensors wake a session, refactoring and simplicity gates, evidence-based tracking | By role only. No model names, accounts, machine names, paths, ports or people | A shared ADK such as this repository |
| Instance | The actual arrangement of one workspace: models in use, accounts, machines, ports, paths, decisions | Links to the common section it fills in | The instance repository |

Put `Scope: common` or `Scope: instance` in the header of every document. When
one document has both, split them into sections and end each section title with
`(common)` or `(instance)`. A common document drafted inside an instance
repository carries no instance facts, so it can be lifted as is.

Progress folders (for example `.agents/progress/`) hold only execution logs and
short-lived files. Anything a person reads goes into a work document or its
evidence folder.

## 3. Work document template and the evidence chain

```markdown
---
issue: <owner>/<repository>#<number>
status: in progress | blocked | waiting for owner | done
path: normal | urgent (if urgent, one line of reason)
coordinator: <session name>
---
# <number> <what the user gets, in one line>

## Goal (owner's words)
> Verbatim. When corrected, keep only the corrected text and note the date.

## Basis
Requirement RQ-08, decision D32, request trace entry REQ-12 … (links)

## Design
What, where and how: problem, root cause, acceptance criteria, separation of
responsibilities. Prohibitions.

## Tasks
| # | Task | Run by | Status | Result |
|---|---|---|---|---|
| 0 | Approve plan and design | owner approval | done (date) | [approval record](…) |
| 1 | Find the failure cause and split the module | implementer | done (commit abc1234) | [result](…) |
| 2 | Review task 1 | reviewer | in progress | |

## Verification
The conditions for calling this done, and their evidence (job ids, screenshots,
recordings, measurements). No evidence, not done.

## Conversation log
Date · who · what was decided, one line each.
```

- **One task row is one task.** The row, together with the goal, basis and
  design sections, is the task's input. No separate instruction file is needed.
- **Requests are kept verbatim and traced.** Every instruction that arrives by
  chat, messenger or note is first recorded word for word in a request source
  file and in a traceability matrix (`REQ-*` → quote → documents and rules that
  reflect it → how it is verified → status). Nothing is summarised away.
- **Plan approval gate.** A work document with a new plan or a major design
  change has an `owner approval` row. Implementation rows after it do not start
  until that row is done.
- **Spec and verification chain.** Feature work links PC → SP/UC → RQ → PL → FE
  → [UT/IT/E2E] → QC in both directions, following
  `.agents/context/development-method.yaml`. QC is written from PC and SP only,
  kept apart from UC and FE. A deterministic checker rejects broken links and
  orphan documents.
- **Delegate the problem, not a line range.** A subtask hands over the problem,
  root cause, goal and acceptance criteria, not "edit lines 40–60 of this file",
  so the implementer may separate responsibilities, split modules and refactor.
  A deterministic complexity gate (file size and growth thresholds) runs before
  review and blocks files that must be split first.

## 4. Execution

The executor and the coordinator session do the following.

1. From a work document's task table, pick a row whose status is `ready` and
   whose approval gate has passed.
2. Launch the subagent or job that matches the row's `run by` column. The
   coordinator does not implement directly; it delegates to subagents.
   - Implementation and review use different models. Which models fill each
     role is an instance decision; do not substitute one silently.
   - The input is the work document's goal (verbatim), basis, design,
     acceptance criteria and the row itself, with refactoring allowed.
   - **A periodic watchdog is required.** Whoever launches a subagent also
     arms a periodic check, so a subagent that never returns cannot stall the
     project. A completion notice alone is not enough.
3. The task writes its result into the evidence folder. The first line of a
   result is `Completion claimed: yes|no`.
4. The executor updates the row's status and result columns, and changes the
   issue comment and board state from the same record.
5. When an implementation row ends, append a complexity gate row and a review
   row that checks the result against the owner's verbatim goal. If review
   fails, verify each finding and append fix rows.

Paperwork in the review tooling (digests, basis file lists, whether an earlier
instruction was reviewed) is filled in by the executor, not by hand. Review
judges content only: drift from the owner's goal, code complexity, and real
defects.

### 4.1 The four layers

| Layer | In company terms | Does | Does not |
|---|---|---|---|
| 4 | Advisor | Hard problems layer 3 cannot solve; adversarial top-level review. Costly, so the problem and its basis go over in one bundle | Routine operation, repetitive work |
| 3 | Lead (coordinator) | Talks with the owner, fixes requirements verbatim, delegates to subagents with a periodic watchdog, judges results | Bulk implementation that exhausts its context; watching and polling |
| 2 | Member (implementer, reviewer) | Analysis, design and implementation as subagents, and independent review. Implementer and reviewer models always differ | Setting direction, widening scope without approval |
| 1 | Sensor | Repetitive judgement: filtering and routing messages, watching delegated jobs (finished, unresponsive, output stalled), detecting new notes on work documents, running a fixed next step, waking layer 3 | Decisions, writing to the outside |

- Layer 3 does not read the mailbox itself. Layer 1 reads first and wakes
  layer 3 only with a summary of what needs it. Messages from people, outages,
  operations, decision requests and notes on work documents are raised at once.
- Layer 1 watches delegated subagents and background jobs as well as messages.
  The coordinator still arms its own periodic watchdog instead of waiting only
  for another model's completion notice.
- Sensors can run crosswise on two different models, so one that keeps
  misjudging is caught by the other.

### 4.2 Normal and urgent paths

| | Normal | Urgent |
|---|---|---|
| What | Features, maintenance, work with slack in the deadline | Production outage, users blocked, same-day deadline |
| Who decides | Default | **Promotion**: when the owner says it is an outage, or asks for a small issue to be fixed quickly, it becomes urgent on the spot, including work already in progress. Otherwise the coordinator decides. Header `path: urgent` with one line of reason |
| Run | Implementer subagent analyses, designs and implements → independent reviewer | The lead layer analyses, implements and tests alone; no plan document or hand-off |
| Review | Before the change lands | After it lands; findings become normal-path fix rows |
| Record | Task table and request trace | Fix first, then fill in the work document and conversation log the same day |
| Unchanged | Production deploy and push approval, prohibitions, debugging and logging rules, complexity gate | Same |

Choose urgent when time comes first, and normal when cost or the review
bottleneck comes first. What layer 3 cannot solve on the urgent path goes to
layer 4.

## 5. Verification and closing

- Write "done" only when every piece of evidence in the verification section
  exists. A passing structure check, a passing test or a worker's word is not
  evidence on its own.
- The spec chain is checked by its deterministic checker, code complexity by
  the complexity gate, and review is forced to compare against the owner's
  verbatim request.
- Screenshots and recordings are linked at an address the owner can open
  directly.
- Every service, batch job or module, and every GPU or paid generation run,
  passes a debug gate first: debug on by default, structured logs, an in-memory
  ring buffer or snapshot, the full reason and intermediate outputs kept on
  failure, and a periodic cleanup job.
- Approval gates come from the project policy (`team_policy`), such as
  production deployment and push. Everything outside them proceeds without
  asking, and what was decided goes into the conversation log.

## 6. Issues and boards

- One issue, one work document. The document header carries the issue address
  and the issue body links to the document. The issue remains the durable
  record the project policy requires (scope, decisions, validation, merge,
  deployment, rollback); the work document is where that content is written and
  edited, and state changes reach both from the same record.
- A board shows the state of work documents. It holds no canonical copy of its
  own; it reads the work documents.

## 7. Following upstream documents

Common documents are edited upstream and read in many places: an instance
repository, a dashboard, another team's coordinator. Instead of copying them by
hand, each reader keeps a dedicated read-only checkout that follows the
upstream branch on a timer.

**Documents and working tree only.** The follower moves a detached checkout
that people and dashboards read. It never moves a branch someone works on, and
it is not how pinned policy or code versions change. Anything an adapter pins
(a package version, a policy guard, a gateway build) stays pinned and moves
only through a reviewed pull request. Do not point the follower at a checkout
whose code is executed.

What `scripts/docs-follow.sh` does on each run:

1. Refuses (exit 4) if the checkout is on a branch.
2. Fetches `<remote>/<branch>`. On failure it records the error and exits with
   git's non-zero status.
3. If the checkout has local changes, it skips, records why and exits 3. It
   does not stash, reset or retry.
4. Otherwise it detaches the checkout at the fetched commit and records
   `before -> after`.

Each step is one JSON line in `<log-dir>/YYYYMMDD.log` (default
`$XDG_STATE_HOME/naia-docs-follow`, kept 14 days). Debug output is on by
default; set `DOCS_FOLLOW_DEBUG=0` to record only results.

Set up a follower (systemd user units):

```sh
# 1. A dedicated detached worktree next to your own clone of the upstream.
git -C <clone> worktree add --detach <clone>-docs origin/main

# 2. Settings for this follower. <name> is any short label; paths are absolute.
mkdir -p ~/.config/naia-docs-follow
cat > ~/.config/naia-docs-follow/<name>.env <<EOF
DOCS_FOLLOW_SCRIPT=<adk-root>/scripts/docs-follow.sh
DOCS_FOLLOW_CHECKOUT=<clone>-docs
DOCS_FOLLOW_REMOTE=origin
DOCS_FOLLOW_BRANCH=main
EOF

# 3. Install the templates and start the five-minute timer.
cp <adk-root>/scripts/systemd/naia-docs-follow@.service \
   <adk-root>/scripts/systemd/naia-docs-follow@.timer ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now naia-docs-follow@<name>.timer

# Run once and check.
systemctl --user start naia-docs-follow@<name>.service
tail -n 3 ~/.local/state/naia-docs-follow/$(date +%Y%m%d).log
```

A skip (exit 3), a refusal (exit 4) or a failed fetch leaves the service in a
failed state, so `systemctl --user --failed` shows it. Without systemd, run the
same command from any scheduler:
`docs-follow.sh --checkout <clone>-docs --branch main`.

**Rollback.** Stop the timer
(`systemctl --user disable --now naia-docs-follow@<name>.timer`), then put the
checkout back on the `before` commit from the log:
`git -C <clone>-docs checkout --detach <before>`. Start the timer again when
the upstream is fixed. A skipped run (exit 3) leaves the checkout where it was;
commit or discard the local edit by hand, and the next run continues.
