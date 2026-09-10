#!/usr/bin/env node
/**
 * QA round queue backed by this Git repository.
 *
 * Every device (a Linux box with a GPU, a Windows laptop, a CI runner) and
 * every AI session that executes tests talks to the same durable queue: files
 * under qa/rounds/<round>/ committed to this repository. There is no push
 * dispatch, no chat ACK, no per-host gateway. A device pulls, claims the next
 * bundle it can run, writes a start receipt with its PID, runs, writes an end
 * receipt with one verdict per case, and pushes. The coordinator (a person or a
 * session) only opens rounds, reads the ledger, and closes rounds.
 *
 * Invariants this file enforces (see .agents/context/qa-rounds.yaml):
 *   - a round is a frozen catalog snapshot (hash recorded at open time)
 *   - a claim IS the acknowledgement; a start receipt IS the start; nothing else counts
 *   - a claim expires; an expired claim may be re-claimed by any device
 *   - every case in a finished bundle gets exactly one verdict from a closed set
 *   - the ledger is derived from receipts, never hand-edited
 *
 * Usage:
 *   node scripts/qa-round.mjs open   --id <round> --catalog <file> --lane <device>:<platform> ... [--candidate name=repo@sha ...]
 *   node scripts/qa-round.mjs claim  --round <round> --device <device> [--session <id>] [--ttl-minutes 90]
 *   node scripts/qa-round.mjs start  --round <round> --device <device> --bundle <id> --pid <pid> [--session <id>] [--command "..."]
 *   node scripts/qa-round.mjs finish --round <round> --device <device> --bundle <id> --results <file> [--session <id>] [--exit-code N]
 *   node scripts/qa-round.mjs ledger --round <round>
 *   node scripts/qa-round.mjs status --round <round>
 *   node scripts/qa-round.mjs close  --round <round>
 *   node scripts/qa-round.mjs validate
 *
 * Set QA_ROUND_NO_SYNC=1 to skip git pull/push (tests, offline inspection).
 *
 * Local-profile module (naia-pj-adk profiles/local). An instance either copies
 * this file to its own scripts/ or runs it where it sits; every exported
 * function takes the repository root explicitly, and the CLI finds it by
 * walking up to the enclosing Git repository rather than assuming a fixed
 * depth. Set QA_ROUND_ROOT to override, or pass --root.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const VERDICTS = ['PASS', 'FAIL', 'BLOCKED', 'NOT_RUN'];
const DEFAULT_TTL_MINUTES = 90;

/**
 * The repository that holds the queue.
 *
 * The naia-comm original resolved this as "one directory above this file",
 * which is true only while the file sits in scripts/. As a profile module it
 * may also live in profiles/local/scripts/, so it walks up to the enclosing
 * Git repository instead of counting directories.
 */
export function resolveRoot(explicit = null, from = path.dirname(fileURLToPath(import.meta.url)), env = process.env) {
  if (explicit) return path.resolve(explicit);
  if (env.QA_ROUND_ROOT) return path.resolve(env.QA_ROUND_ROOT);
  let current = path.resolve(from);
  for (;;) {
    if (fs.existsSync(path.join(current, '.git'))) return current;
    const parent = path.dirname(current);
    if (parent === current) fail('cannot find the repository root; pass --root or set QA_ROUND_ROOT');
    current = parent;
  }
}

function nowIso() { return new Date().toISOString(); }
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}
function sha256(text) { return crypto.createHash('sha256').update(text).digest('hex'); }
function fail(message) { throw new Error(message); }

/* ----------------------------------------------------------------------- */
/* Git.                                                                      */

export function git(root, args, options = {}) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options }).trim();
}

function hasRemote(root) {
  try { return git(root, ['remote']).split('\n').includes('origin'); } catch { return false; }
}

function syncEnabled(env = process.env) {
  return !['1', 'true', 'yes', 'on'].includes(String(env.QA_ROUND_NO_SYNC || '').toLowerCase());
}

/** Bring the queue up to date before reading it. */
export function pull(root, env = process.env) {
  if (!syncEnabled(env) || !hasRemote(root)) return;
  git(root, ['pull', '--rebase', '--autostash', '--quiet']);
}

/** Commit the given paths and push; on a rejected push, rebase and retry. */
export function commitAndPush(root, paths, message, env = process.env) {
  git(root, ['add', '--', ...paths]);
  const staged = git(root, ['diff', '--cached', '--name-only']);
  if (!staged) return null;
  git(root, ['commit', '--quiet', '-m', message]);
  const sha = git(root, ['rev-parse', 'HEAD']);
  if (!syncEnabled(env) || !hasRemote(root)) return sha;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try { git(root, ['push', '--quiet']); return git(root, ['rev-parse', 'HEAD']); }
    catch (error) {
      if (attempt === 5) throw error;
      git(root, ['pull', '--rebase', '--autostash', '--quiet']);
    }
  }
  return sha;
}

/* ----------------------------------------------------------------------- */
/* Layout.                                                                   */

export function roundDir(root, id) { return path.join(root, 'qa', 'rounds', id); }
function claimFile(root, id, device, bundle) { return path.join(roundDir(root, id), 'claims', device, `${bundle}.json`); }
function receiptDir(root, id, device, bundle, attempt) { return path.join(roundDir(root, id), 'receipts', device, bundle, `attempt-${attempt}`); }

export function loadRound(root, id) {
  const dir = roundDir(root, id);
  if (!fs.existsSync(path.join(dir, 'round.json'))) fail(`round not found: ${id}`);
  const round = readJson(path.join(dir, 'round.json'));
  const catalogText = fs.readFileSync(path.join(dir, 'catalog.json'), 'utf8');
  // Git may materialize checked-in JSON with CRLF on Windows even though the
  // coordinator hashed the canonical LF representation when freezing it.
  // Normalize line endings before comparing so checkout policy is not treated
  // as catalog tampering.
  if (sha256(catalogText.replace(/\r\n/g, '\n')) !== round.catalogHash) fail(`catalog of round ${id} was modified after it was frozen`);
  const catalog = JSON.parse(catalogText);
  return { dir, round, catalog, bundles: bundlesOf(catalog) };
}

/** Group frozen cases by bundle; a bundle is the unit a device claims. */
export function bundlesOf(catalog) {
  const bundles = new Map();
  for (const item of catalog.cases) {
    const id = item.bundle || item.key;
    if (!bundles.has(id)) bundles.set(id, { id, lifecycle: item.lifecycle || 'shared-app', platforms: new Set(), cases: [] });
    const bundle = bundles.get(id);
    bundle.cases.push(item);
    for (const platform of item.platforms || []) bundle.platforms.add(platform);
    if (item.lifecycle && item.lifecycle !== bundle.lifecycle) fail(`bundle ${id} mixes lifecycles ${bundle.lifecycle} and ${item.lifecycle}`);
  }
  return [...bundles.values()].map((b) => ({ ...b, platforms: [...b.platforms].sort() }));
}

export function validateCatalog(catalog) {
  if (!catalog || !Array.isArray(catalog.cases) || catalog.cases.length === 0) fail('catalog.cases must be a non-empty array');
  const keys = new Set();
  for (const item of catalog.cases) {
    for (const field of ['key', 'title', 'method', 'expected']) {
      if (typeof item[field] !== 'string' || !item[field].trim()) fail(`case ${item.key || '?'} is missing ${field}`);
    }
    if (keys.has(item.key)) fail(`duplicate case key ${item.key}`);
    keys.add(item.key);
    if (!Array.isArray(item.platforms) || item.platforms.length === 0) fail(`case ${item.key} declares no platforms`);
  }
  bundlesOf(catalog);
  return catalog;
}

/* ----------------------------------------------------------------------- */
/* Devices.                                                                  */

/** devices/<id>.yaml is a flat `key: value` file; we only need platform and owner. */
export function loadDevice(root, id) {
  const file = path.join(root, 'devices', `${id}.yaml`);
  if (!fs.existsSync(file)) fail(`device not registered: devices/${id}.yaml`);
  const device = { id };
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([a-z_]+):\s*(.+?)\s*$/);
    if (match) device[match[1]] = match[2].replace(/^["']|["']$/g, '');
  }
  if (!device.platform) fail(`device ${id} declares no platform`);
  return device;
}

/* ----------------------------------------------------------------------- */
/* State derivation (pure; reads files, never mutates).                     */

export function readClaims(root, id) {
  const dir = path.join(roundDir(root, id), 'claims');
  const claims = [];
  if (!fs.existsSync(dir)) return claims;
  for (const device of fs.readdirSync(dir)) {
    const deviceDir = path.join(dir, device);
    if (!fs.statSync(deviceDir).isDirectory()) continue;
    for (const file of fs.readdirSync(deviceDir)) {
      if (file.endsWith('.json')) claims.push(readJson(path.join(deviceDir, file)));
    }
  }
  return claims;
}

export function readReceipts(root, id) {
  const dir = path.join(roundDir(root, id), 'receipts');
  const receipts = [];
  if (!fs.existsSync(dir)) return receipts;
  for (const device of fs.readdirSync(dir)) {
    const deviceDir = path.join(dir, device);
    if (!fs.statSync(deviceDir).isDirectory()) continue;
    for (const bundle of fs.readdirSync(deviceDir)) {
      const bundleDir = path.join(deviceDir, bundle);
      if (!fs.statSync(bundleDir).isDirectory()) continue;
      for (const attemptName of fs.readdirSync(bundleDir)) {
        const attemptDir = path.join(bundleDir, attemptName);
        if (!fs.statSync(attemptDir).isDirectory()) continue;
        const attempt = Number(attemptName.replace(/^attempt-/, '')) || 0;
        const start = fs.existsSync(path.join(attemptDir, 'start.json')) ? readJson(path.join(attemptDir, 'start.json')) : null;
        const end = fs.existsSync(path.join(attemptDir, 'end.json')) ? readJson(path.join(attemptDir, 'end.json')) : null;
        receipts.push({ device, bundle, attempt, start, end });
      }
    }
  }
  return receipts;
}

function isExpired(claim, at = Date.now()) { return Date.parse(claim.expiresAt) <= at; }

/** Which (bundle, platform) pairs are done, live-claimed, or open. */
export function deriveState(root, id, at = Date.now()) {
  const { round, bundles } = loadRound(root, id);
  const platformOf = Object.fromEntries(round.lanes.map((lane) => [lane.device, lane.platform]));
  const claims = readClaims(root, id);
  const receipts = readReceipts(root, id);
  const done = new Set(receipts.filter((r) => r.end).map((r) => `${r.bundle}@${platformOf[r.device] || '?'}`));
  const live = new Map();
  const stale = [];
  for (const claim of claims) {
    const key = `${claim.bundle}@${platformOf[claim.device] || '?'}`;
    if (done.has(key)) continue;
    if (isExpired(claim, at)) stale.push(claim); else live.set(key, claim);
  }
  const open = [];
  for (const bundle of bundles) {
    for (const platform of bundle.platforms) {
      if (!round.lanes.some((lane) => lane.platform === platform)) continue; // no lane for this platform in this round
      const key = `${bundle.id}@${platform}`;
      if (!done.has(key) && !live.has(key)) open.push({ bundle: bundle.id, platform, lifecycle: bundle.lifecycle, cases: bundle.cases.length });
    }
  }
  return { round, bundles, claims, receipts, done, live, stale, open, platformOf };
}

/* ----------------------------------------------------------------------- */
/* Commands.                                                                 */

export function open(root, { id, catalogFile, lanes, candidates = {}, openedBy = process.env.USER || 'unknown' }, env = process.env) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) fail('round id must be lowercase letters, digits and dashes');
  const dir = roundDir(root, id);
  if (fs.existsSync(dir)) fail(`round already exists: ${id}`);
  if (!lanes || lanes.length === 0) fail('at least one lane (device:platform) is required');
  pull(root, env);
  for (const lane of lanes) {
    const device = loadDevice(root, lane.device);
    if (device.platform !== lane.platform) fail(`lane ${lane.device} says ${lane.platform} but devices/${lane.device}.yaml says ${device.platform}`);
  }
  const catalog = validateCatalog(readJson(catalogFile));
  const catalogText = `${JSON.stringify(catalog, null, 2)}\n`;
  const round = { id, status: 'open', openedAt: nowIso(), openedBy, lanes, candidates, catalogHash: sha256(catalogText), cases: catalog.cases.length, bundles: bundlesOf(catalog).length };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'catalog.json'), catalogText);
  writeJson(path.join(dir, 'round.json'), round);
  commitAndPush(root, [dir], `qa(${id}): open round with ${round.cases} cases in ${round.bundles} bundles`, env);
  return round;
}

/** Claim the next runnable bundle for a device. Returns null when nothing is open for it. */
export function claim(root, { id, device: deviceId, session = null, ttlMinutes = DEFAULT_TTL_MINUTES, prefer = null }, env = process.env) {
  const device = loadDevice(root, deviceId);
  for (let attempt = 1; attempt <= 5; attempt++) {
    pull(root, env);
    const state = deriveState(root, id);
    if (state.round.status !== 'open') fail(`round ${id} is ${state.round.status}`);
    if (!state.round.lanes.some((lane) => lane.device === deviceId)) fail(`device ${deviceId} has no lane in round ${id}`);
    const candidates = state.open.filter((item) => item.platform === device.platform);
    if (candidates.length === 0) return null;
    const pick = (prefer && candidates.find((c) => c.bundle === prefer)) || candidates[0];
    const record = {
      round: id, bundle: pick.bundle, platform: pick.platform, device: deviceId, session,
      claimedAt: nowIso(), expiresAt: new Date(Date.now() + ttlMinutes * 60 * 1000).toISOString(),
      attempt: state.claims.filter((c) => c.bundle === pick.bundle && state.platformOf[c.device] === pick.platform).length + 1,
    };
    const file = claimFile(root, id, deviceId, pick.bundle);
    writeJson(file, record);
    try {
      commitAndPush(root, [file], `qa(${id}): ${deviceId} claims ${pick.bundle}`, env);
    } catch (error) {
      fs.rmSync(file, { force: true });
      if (attempt === 5) throw error;
      continue;
    }
    // After a rebase another device may have claimed the same bundle first; the earlier claim wins.
    const after = deriveState(root, id);
    const winner = after.live.get(`${pick.bundle}@${pick.platform}`);
    if (winner && winner.device !== deviceId) { fs.rmSync(file, { force: true }); commitAndPush(root, [file], `qa(${id}): ${deviceId} yields ${pick.bundle}`, env); continue; }
    const bundle = after.bundles.find((b) => b.id === pick.bundle);
    return { ...record, lifecycle: bundle.lifecycle, cases: bundle.cases };
  }
  return null;
}

function ownClaim(root, id, device, bundle, session) {
  const file = claimFile(root, id, device, bundle);
  if (!fs.existsSync(file)) fail(`no claim for ${bundle} by ${device}; claim before starting`);
  const claimRecord = readJson(file);
  if (claimRecord.session && claimRecord.session !== session) fail(`claim for ${bundle} by ${device} belongs to session ${claimRecord.session}, not ${session || '(none)'}; this session lost the bundle`);
  return claimRecord;
}

export function start(root, { id, device, bundle, pid, session = null, command = null, binarySha256 = null }, env = process.env) {
  pull(root, env);
  const claimRecord = ownClaim(root, id, device, bundle, session);
  if (isExpired(claimRecord)) fail(`claim for ${bundle} by ${device} expired at ${claimRecord.expiresAt}; claim again`);
  if (!Number.isInteger(pid) || pid <= 0) fail('start needs the real PID of the runner');
  const receipt = { round: id, bundle, device, session, attempt: claimRecord.attempt, pid, command, binarySha256, startedAt: nowIso(), claimedAt: claimRecord.claimedAt };
  const target = path.join(receiptDir(root, id, device, bundle, claimRecord.attempt), 'start.json');
  writeJson(target, receipt);
  commitAndPush(root, [target], `qa(${id}): ${device} starts ${bundle} (pid ${pid})`, env);
  return receipt;
}

export function finish(root, { id, device, bundle, resultsFile, session = null, exitCode = null }, env = process.env) {
  pull(root, env);
  const { bundles } = loadRound(root, id);
  const spec = bundles.find((b) => b.id === bundle) || fail(`unknown bundle ${bundle}`);
  const claimRecord = ownClaim(root, id, device, bundle, session);
  const startFile = path.join(receiptDir(root, id, device, bundle, claimRecord.attempt), 'start.json');
  if (!fs.existsSync(startFile)) fail(`no start receipt for ${bundle} by ${device}; a result without a start is not evidence`);
  const results = readJson(resultsFile);
  if (!Array.isArray(results)) fail('results must be an array of {case, verdict, reason?, evidence?}');
  const byCase = new Map(results.map((r) => [r.case, r]));
  for (const item of spec.cases) {
    const r = byCase.get(item.key);
    if (!r) fail(`missing verdict for ${item.key}`);
    if (!VERDICTS.includes(r.verdict)) fail(`case ${item.key}: verdict must be one of ${VERDICTS.join('/')}`);
    if (r.verdict !== 'PASS' && !(typeof r.reason === 'string' && r.reason.trim())) fail(`case ${item.key}: ${r.verdict} needs a reason`);
  }
  for (const r of results) if (!spec.cases.some((c) => c.key === r.case)) fail(`result for ${r.case} does not belong to bundle ${bundle}`);
  const late = isExpired(claimRecord);
  const receipt = { round: id, bundle, device, session, attempt: claimRecord.attempt, endedAt: nowIso(), exitCode, late, results };
  const target = path.join(receiptDir(root, id, device, bundle, claimRecord.attempt), 'end.json');
  writeJson(target, receipt);
  commitAndPush(root, [target], `qa(${id}): ${device} finishes ${bundle}${late ? ' (late)' : ''}`, env);
  return receipt;
}

/** Latest verdict per case per platform, derived from end receipts only. */
export function ledger(root, id, { write = true } = {}, env = process.env) {
  if (write) pull(root, env);
  const state = deriveState(root, id);
  const verdicts = {};
  for (const receipt of state.receipts.filter((r) => r.end).sort((a, b) => a.end.endedAt.localeCompare(b.end.endedAt))) {
    const platform = state.platformOf[receipt.device] || '?';
    for (const r of receipt.end.results) {
      verdicts[r.case] ||= {};
      const current = verdicts[r.case][platform];
      // An earlier non-late verdict is not overwritten by a late one from a lost session.
      if (current && !current.late && receipt.end.late) continue;
      verdicts[r.case][platform] = { verdict: r.verdict, reason: r.reason || null, device: receipt.device, endedAt: receipt.end.endedAt, late: !!receipt.end.late };
    }
  }
  const platforms = [...new Set(state.round.lanes.map((l) => l.platform))].sort();
  const counts = {};
  for (const platform of platforms) {
    counts[platform] = Object.fromEntries(VERDICTS.map((v) => [v, 0]));
    for (const item of state.bundles.flatMap((b) => b.cases)) {
      if (!item.platforms.includes(platform)) continue;
      const v = verdicts[item.key]?.[platform]?.verdict || 'NOT_RUN';
      counts[platform][v]++;
    }
  }
  const out = { round: id, derivedAt: nowIso(), counts, open: state.open.length, live: state.live.size, stale: state.stale.length, verdicts };
  if (write) {
    const file = path.join(roundDir(root, id), 'ledger.json');
    writeJson(file, out);
    commitAndPush(root, [file], `qa(${id}): ledger ${platforms.map((p) => `${p} ${VERDICTS.map((v) => `${v[0]}${counts[p][v]}`).join('/')}`).join(', ')}`, env);
  }
  return out;
}

export function status(root, id, env = process.env) {
  pull(root, env);
  const state = deriveState(root, id);
  const lanes = state.round.lanes.map((lane) => {
    const mine = (c) => c.device === lane.device;
    return {
      device: lane.device, platform: lane.platform,
      live: [...state.live.values()].filter(mine).map((c) => c.bundle),
      stale: state.stale.filter(mine).map((c) => c.bundle),
      done: state.receipts.filter((r) => r.end && mine(r)).length,
      openForPlatform: state.open.filter((o) => o.platform === lane.platform).length,
    };
  });
  return { round: state.round.id, status: state.round.status, lanes, open: state.open, stale: state.stale.map((c) => ({ bundle: c.bundle, device: c.device, expiresAt: c.expiresAt })) };
}

export function close(root, { id, force = false }, env = process.env) {
  pull(root, env);
  const state = deriveState(root, id);
  if (state.round.status === 'closed') return state.round;
  if (state.open.length > 0 && !force) fail(`round ${id} still has ${state.open.length} open bundle/platform pairs; finish them or close --force with a reason in the issue`);
  if (state.live.size > 0 && !force) fail(`round ${id} still has ${state.live.size} live claims`);
  const out = ledger(root, id, { write: false });
  const dir = roundDir(root, id);
  const round = { ...state.round, status: 'closed', closedAt: nowIso(), forced: force, finalCounts: out.counts };
  writeJson(path.join(dir, 'round.json'), round);
  writeJson(path.join(dir, 'ledger.json'), out);
  commitAndPush(root, [dir], `qa(${id}): close round${force ? ' (forced)' : ''}`, env);
  return round;
}

/** Structural invariants over every round; used by npm test. */
export function validate(root) {
  const base = path.join(root, 'qa', 'rounds');
  const problems = [];
  if (!fs.existsSync(base)) return problems;
  for (const id of fs.readdirSync(base)) {
    if (!fs.statSync(path.join(base, id)).isDirectory()) continue;
    let state;
    try { state = deriveState(root, id); } catch (error) { problems.push(`${id}: ${error.message}`); continue; }
    const bundleIds = new Set(state.bundles.map((b) => b.id));
    for (const c of state.claims) {
      if (!bundleIds.has(c.bundle)) problems.push(`${id}: claim ${c.device}/${c.bundle} references an unknown bundle`);
      if (!state.round.lanes.some((l) => l.device === c.device)) problems.push(`${id}: claim by ${c.device} which has no lane`);
    }
    for (const r of state.receipts) {
      if (!bundleIds.has(r.bundle)) problems.push(`${id}: receipt ${r.device}/${r.bundle} references an unknown bundle`);
      if (r.end && !r.start) problems.push(`${id}: ${r.device}/${r.bundle} has an end receipt without a start receipt`);
      if (r.start && !(Number.isInteger(r.start.pid) && r.start.pid > 0)) problems.push(`${id}: ${r.device}/${r.bundle} start receipt has no PID`);
    }
    const seen = new Map();
    for (const [key, c] of state.live) { if (seen.has(key)) problems.push(`${id}: two live claims on ${key}`); seen.set(key, c); }
    if (state.round.status === 'closed' && !fs.existsSync(path.join(roundDir(root, id), 'ledger.json'))) problems.push(`${id}: closed without a ledger`);
  }
  return problems;
}

/* ----------------------------------------------------------------------- */
/* CLI.                                                                      */

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[key] = true;
      else { (out[key] === undefined ? (out[key] = next) : (out[key] = [].concat(out[key], next))); i++; }
    } else out._.push(a);
  }
  return out;
}

function main() {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  const root = resolveRoot(args.root === true ? null : args.root);
  const print = (value) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  switch (command) {
    case 'open': {
      const lanes = [].concat(args.lane || []).map((s) => { const [device, platform] = String(s).split(':'); return { device, platform }; });
      const candidates = {};
      for (const c of [].concat(args.candidate || [])) { const [name, ref] = String(c).split('='); candidates[name] = ref; }
      return print(open(root, { id: args.id, catalogFile: args.catalog, lanes, candidates }));
    }
    case 'claim': {
      const result = claim(root, { id: args.round, device: args.device, session: args.session || null, ttlMinutes: Number(args['ttl-minutes'] || DEFAULT_TTL_MINUTES), prefer: args.prefer || null });
      if (!result) { process.stderr.write('nothing open for this device\n'); process.exitCode = 3; return; }
      return print(result);
    }
    case 'start': return print(start(root, { id: args.round, device: args.device, bundle: args.bundle, pid: Number(args.pid), session: args.session || null, command: args.command || null, binarySha256: args['binary-sha256'] || null }));
    case 'finish': return print(finish(root, { id: args.round, device: args.device, bundle: args.bundle, resultsFile: args.results, session: args.session || null, exitCode: args['exit-code'] === undefined ? null : Number(args['exit-code']) }));
    case 'ledger': return print(ledger(root, args.round));
    case 'status': return print(status(root, args.round));
    case 'close': return print(close(root, { id: args.round, force: !!args.force }));
    case 'validate': {
      const problems = validate(root);
      if (problems.length) { for (const p of problems) process.stderr.write(`${p}\n`); process.exitCode = 1; }
      else process.stdout.write('qa rounds: structure valid\n');
      return;
    }
    default:
      process.stderr.write('usage: qa-round.mjs <open|claim|start|finish|ledger|status|close|validate> ...\n');
      process.exitCode = 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
