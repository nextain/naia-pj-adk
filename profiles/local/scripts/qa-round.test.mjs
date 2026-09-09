// node profiles/local/scripts/qa-round.test.mjs
//
// Two devices (linux, windows) share one bare remote and work one round to
// closure. Every call passes its repository root explicitly, so this test runs
// unchanged whether the module sits in profiles/local/scripts/ here or in an
// instance's own scripts/ after it copies the profile.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as qa from './qa-round.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-round-'));
const sh = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

// bare remote + seed clone with device registry
const bare = path.join(tmp, 'remote.git');
execFileSync('git', ['init', '--bare', '-q', '-b', 'main', bare]);
const seed = path.join(tmp, 'seed');
execFileSync('git', ['clone', '-q', bare, seed]);
for (const dir of [seed]) {
  sh(dir, 'config', 'user.email', 'qa@test');
  sh(dir, 'config', 'user.name', 'qa');
}
fs.mkdirSync(path.join(seed, 'devices'), { recursive: true });
fs.writeFileSync(path.join(seed, 'devices', 'linux-3090.yaml'), 'id: linux-3090\nplatform: linux\nowner: luke\n');
fs.writeFileSync(path.join(seed, 'devices', 'windows-4060.yaml'), 'id: windows-4060\nplatform: windows\nowner: luke\n');
sh(seed, 'add', '.'); sh(seed, 'commit', '-q', '-m', 'devices'); sh(seed, 'push', '-q', '-u', 'origin', 'main');

const catalog = {
  cases: [
    { key: 'QC-001', title: 'boot', method: 'launch app', expected: 'window shows', bundle: 'B01', lifecycle: 'shared-app', platforms: ['linux', 'windows'] },
    { key: 'QC-002', title: 'settings', method: 'open settings', expected: 'tabs render', bundle: 'B01', lifecycle: 'shared-app', platforms: ['linux', 'windows'] },
    { key: 'QC-003', title: 'restart restore', method: 'restart', expected: 'state restored', bundle: 'B02', lifecycle: 'restart', platforms: ['linux', 'windows'] },
    { key: 'QC-004', title: 'gpu voice', method: 'record', expected: 'transcript', bundle: 'B03', lifecycle: 'shared-app', platforms: ['linux'] },
  ],
};
const catalogFile = path.join(tmp, 'catalog.json');
fs.writeFileSync(catalogFile, JSON.stringify(catalog));

// coordinator opens the round from the seed clone
const round = qa.open(seed, { id: 'r-test', catalogFile, lanes: [{ device: 'linux-3090', platform: 'linux' }, { device: 'windows-4060', platform: 'windows' }], candidates: { shell: 'nextain/naia-shell@abc' } });
assert.equal(round.cases, 4); assert.equal(round.bundles, 3);

// tampering with the frozen catalog is detected
const frozen = path.join(seed, 'qa/rounds/r-test/catalog.json');
const original = fs.readFileSync(frozen, 'utf8');
fs.writeFileSync(frozen, original.replace('window shows', 'anything'));
assert.throws(() => qa.loadRound(seed, 'r-test'), /modified after it was frozen/);
fs.writeFileSync(frozen, original);

// two devices clone independently
function device(name) {
  const dir = path.join(tmp, name);
  execFileSync('git', ['clone', '-q', bare, dir]);
  sh(dir, 'config', 'user.email', `${name}@test`); sh(dir, 'config', 'user.name', name);
  return dir;
}
const linux = device('linux-3090');
const windows = device('windows-4060');

// linux claims first open bundle; windows claims the same bundle id on its own platform (allowed: different platform)
const c1 = qa.claim(linux, { id: 'r-test', device: 'linux-3090', session: 'sess-A', ttlMinutes: 60 });
assert.equal(c1.bundle, 'B01'); assert.equal(c1.cases.length, 2);
const w1 = qa.claim(windows, { id: 'r-test', device: 'windows-4060', session: 'sess-W' });
assert.equal(w1.bundle, 'B01'); assert.equal(w1.platform, 'windows');

// a second linux session cannot claim B01@linux while the first claim is live
const linux2 = device('linux-3090-b');
fs.writeFileSync(path.join(linux2, 'devices', 'linux-3090.yaml'), 'id: linux-3090\nplatform: linux\n'); // same device id, second session
const c2 = qa.claim(linux2, { id: 'r-test', device: 'linux-3090', session: 'sess-B' });
assert.equal(c2.bundle, 'B02', 'second session gets the next bundle, not the live one');

// finishing without a start receipt is refused
const results1 = path.join(tmp, 'r1.json');
fs.writeFileSync(results1, JSON.stringify([{ case: 'QC-001', verdict: 'PASS' }, { case: 'QC-002', verdict: 'FAIL', reason: 'tabs missing' }]));
assert.throws(() => qa.finish(linux, { id: 'r-test', device: 'linux-3090', bundle: 'B01', resultsFile: results1, session: 'sess-A' }), /no start receipt/);

// start needs a real pid; then finish; verdicts must cover every case with reasons for non-PASS
assert.throws(() => qa.start(linux, { id: 'r-test', device: 'linux-3090', bundle: 'B01', pid: 0, session: 'sess-A' }), /real PID/);
assert.throws(() => qa.start(linux, { id: 'r-test', device: 'linux-3090', bundle: 'B01', pid: 5, session: 'sess-X' }), /belongs to session sess-A/);
qa.start(linux, { id: 'r-test', device: 'linux-3090', bundle: 'B01', pid: 4242, session: 'sess-A', command: 'wdio run' });
const bad = path.join(tmp, 'bad.json');
fs.writeFileSync(bad, JSON.stringify([{ case: 'QC-001', verdict: 'PASS' }]));
assert.throws(() => qa.finish(linux, { id: 'r-test', device: 'linux-3090', bundle: 'B01', resultsFile: bad, session: 'sess-A' }), /missing verdict for QC-002/);
fs.writeFileSync(bad, JSON.stringify([{ case: 'QC-001', verdict: 'PASS' }, { case: 'QC-002', verdict: 'BLOCKED' }]));
assert.throws(() => qa.finish(linux, { id: 'r-test', device: 'linux-3090', bundle: 'B01', resultsFile: bad, session: 'sess-A' }), /BLOCKED needs a reason/);
qa.finish(linux, { id: 'r-test', device: 'linux-3090', bundle: 'B01', resultsFile: results1, session: 'sess-A', exitCode: 1 });

// windows session dies: its claim expires; linux may re-claim B01@windows? No: linux is not a windows lane. Simulate expiry and a fresh windows session.
const wClaim = path.join(windows, 'qa/rounds/r-test/claims/windows-4060/B01.json');
const rec = JSON.parse(fs.readFileSync(wClaim, 'utf8'));
rec.expiresAt = new Date(Date.now() - 1000).toISOString();
fs.writeFileSync(wClaim, JSON.stringify(rec));
qa.commitAndPush(windows, [wClaim], 'test: expire windows claim');
const windows2 = device('windows-4060-b');
const w2 = qa.claim(windows2, { id: 'r-test', device: 'windows-4060', session: 'sess-W2' });
assert.equal(w2.bundle, 'B01', 'expired claim is re-claimable');
assert.equal(w2.attempt, 2);
qa.start(windows2, { id: 'r-test', device: 'windows-4060', bundle: 'B01', pid: 777, session: 'sess-W2' });
const wres = path.join(tmp, 'w.json');
fs.writeFileSync(wres, JSON.stringify([{ case: 'QC-001', verdict: 'PASS' }, { case: 'QC-002', verdict: 'PASS' }]));
qa.finish(windows2, { id: 'r-test', device: 'windows-4060', bundle: 'B01', resultsFile: wres, session: 'sess-W2' });

// the dead windows session comes back: its expired claim cannot start again
qa.pull(windows);
assert.throws(() => qa.start(windows, { id: 'r-test', device: 'windows-4060', bundle: 'B01', pid: 778, session: 'sess-W' }), /belongs to session sess-W2/);

// ledger derives from receipts only
let led = qa.ledger(seed, 'r-test');
assert.deepEqual(led.counts.linux, { PASS: 1, FAIL: 1, BLOCKED: 0, NOT_RUN: 2 });
assert.deepEqual(led.counts.windows, { PASS: 2, FAIL: 0, BLOCKED: 0, NOT_RUN: 1 });
assert.equal(led.verdicts['QC-002'].windows.device, 'windows-4060');

// status shows the second linux session holding B02 live
const st = qa.status(seed, 'r-test');
const linuxLane = st.lanes.find((l) => l.device === 'linux-3090');
assert.deepEqual(linuxLane.live, ['B02']);
assert.equal(linuxLane.done, 1);

// close is refused while bundles are open
assert.throws(() => qa.close(seed, { id: 'r-test' }), /open bundle/);

// finish the rest: linux B02 (sess-B), B03; windows B02
qa.start(linux2, { id: 'r-test', device: 'linux-3090', bundle: 'B02', pid: 1, session: 'sess-B' });
const r2 = path.join(tmp, 'r2.json');
fs.writeFileSync(r2, JSON.stringify([{ case: 'QC-003', verdict: 'NOT_RUN', reason: 'restart hook not wired' }]));
qa.finish(linux2, { id: 'r-test', device: 'linux-3090', bundle: 'B02', resultsFile: r2, session: 'sess-B' });
const c3 = qa.claim(linux, { id: 'r-test', device: 'linux-3090', session: 'sess-A' });
assert.equal(c3.bundle, 'B03');
qa.start(linux, { id: 'r-test', device: 'linux-3090', bundle: 'B03', pid: 2, session: 'sess-A' });
const r3 = path.join(tmp, 'r3.json');
fs.writeFileSync(r3, JSON.stringify([{ case: 'QC-004', verdict: 'BLOCKED', reason: 'no API key on device' }]));
qa.finish(linux, { id: 'r-test', device: 'linux-3090', bundle: 'B03', resultsFile: r3, session: 'sess-A' });
assert.equal(qa.claim(linux, { id: 'r-test', device: 'linux-3090' }), null, 'nothing left for linux');
const w3 = qa.claim(windows2, { id: 'r-test', device: 'windows-4060' });
assert.equal(w3.bundle, 'B02');
qa.start(windows2, { id: 'r-test', device: 'windows-4060', bundle: 'B02', pid: 3 });
fs.writeFileSync(r2, JSON.stringify([{ case: 'QC-003', verdict: 'PASS' }]));
qa.finish(windows2, { id: 'r-test', device: 'windows-4060', bundle: 'B02', resultsFile: r2 });

// structural validation and close
qa.pull(seed); assert.deepEqual(qa.validate(seed), []);
const closed = qa.close(seed, { id: 'r-test' });
assert.equal(closed.status, 'closed');
assert.deepEqual(closed.finalCounts.linux, { PASS: 1, FAIL: 1, BLOCKED: 1, NOT_RUN: 1 });
assert.deepEqual(closed.finalCounts.windows, { PASS: 3, FAIL: 0, BLOCKED: 0, NOT_RUN: 0 });
assert.throws(() => qa.claim(linux, { id: 'r-test', device: 'linux-3090' }), /is closed/);

// every device sees the same history
for (const dir of [linux, windows2]) { qa.pull(dir); assert.equal(sh(dir, 'rev-parse', 'HEAD'), sh(seed, 'rev-parse', 'HEAD')); }

// the module finds its own repository root, wherever the profile was copied to
assert.equal(qa.resolveRoot(seed), seed);
assert.equal(qa.resolveRoot(null, path.join(seed, 'qa', 'rounds'), {}), seed);
assert.equal(qa.resolveRoot(null, seed, { QA_ROUND_ROOT: bare }), bare);

fs.rmSync(tmp, { recursive: true, force: true });
console.log('qa-round: PASS');
