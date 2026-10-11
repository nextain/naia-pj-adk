// Feature-regression prevention rules: pinned copy from naia-adk is intact and routed from AGENTS.md.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => fs.readFileSync(path.join(root, f));

const REQUIRED = [
	"remove_needs_requester_quote", "coordinator_decision_not_basis", "keep_baseline_section", "impossible_needs_evidence",
	"deletion_needs_basis", "done_needs_all_entrypoints", "requester_quote_fail_not_overridden", "repeat_review_triage",
	"subtask_quotes_mission", "drift_recovery_order",
];

test("pinned copy matches the lock hashes", () => {
	const lock = JSON.parse(read("vendor/naia-adk-process-rules.lock.json"));
	assert.equal(lock.source_repo, "nextain/naia-adk");
	assert.ok(lock.files.length >= 2);
	for (const f of lock.files) {
		assert.equal(crypto.createHash("sha256").update(read(f.path)).digest("hex"), f.sha256, f.path);
	}
});

test("every required rule is a non-trivial string", () => {
	const spec = JSON.parse(read(".agents/context/regression-prevention.json"));
	for (const k of REQUIRED) {
		assert.equal(typeof spec.rules?.[k], "string", k);
		assert.ok(spec.rules[k].trim().length >= 40, k);
	}
	assert.match(JSON.stringify(spec), /docs\/guides\/drift-recovery\.md/);
});

test("AGENTS.md routes to the rules and the procedure", () => {
	const agents = read("AGENTS.md").toString("utf8");
	assert.match(agents, /^- .*`\.agents\/context\/regression-prevention\.json`.*`docs\/guides\/drift-recovery\.md`/m);
});
