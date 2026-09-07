import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  validateNativeCommandContract,
  validateNativeCommandInvocation,
  validateNativeDependency,
} from './native-command-validator.mjs';

const contract = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'ops/gateway/native-command-contract.json'), 'utf8'));

test('native validator consumes the checked-in command contract', async () => {
  assert.equal(validateNativeCommandContract(contract), true);
  assert.equal(await validateNativeCommandInvocation(contract, ['service', 'status']), true);
  assert.equal(await validateNativeCommandInvocation(contract, ['artifacts', 'list']), true);
  assert.equal(await validateNativeCommandInvocation(contract, ['submit', '--issue', '17']), true, 'project commands remain policy-guarded');
});

test('native validator rejects unsupported or broadened command forms', async () => {
  await assert.rejects(() => validateNativeCommandInvocation(contract, ['retry']), /unsupported/);
  await assert.rejects(() => validateNativeCommandInvocation(contract, ['artifacts', 'prune']), /unsupported/);
  await assert.rejects(() => validateNativeCommandInvocation(contract, ['cancel', '--job', 'one', '--force']), /cancel/);
  await assert.rejects(() => validateNativeCommandInvocation(contract, ['attachment', '--output', 'relative.dat']), /absolute/);
  await assert.rejects(() => validateNativeCommandInvocation(contract, ['status', '--']), /invalid/);
});

test('native validator fails an incompatible wrapper contract before dispatch', () => {
  const incompatible = structuredClone(contract);
  incompatible.native_dependency.adapter.readonly_commands[0] = 42;
  assert.throws(() => validateNativeCommandContract(incompatible), /adapter readonly surface/);
  const staleSurface = structuredClone(contract);
  staleSurface.readonly_commands = ['status'];
  assert.throws(() => validateNativeCommandContract(staleSurface), /native surface with a wrapper dependency/);
});

const nativeRoot = process.env.NAIA_NATIVE_ROOT;
test('native wrapper matches the explicitly supplied native implementation', { skip: !nativeRoot }, async () => {
  assert.equal(await validateNativeDependency(contract, nativeRoot), true);
  assert.equal(await validateNativeCommandInvocation(contract, ['status'], { nativeRoot }), true);
  await assert.rejects(() => validateNativeDependency(contract, undefined), /absolute/);
});

test('native source mutation is rejected before dispatch and errors do not expose loader details', { skip: !nativeRoot }, async () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'naia-pj-native-drift-'));
  const modulePath = path.join(temporaryRoot, contract.native_dependency.module);
  fs.mkdirSync(path.dirname(modulePath), { recursive: true });
  const source = fs.readFileSync(path.join(nativeRoot, contract.native_dependency.module), 'utf8');
  const mutatedSource = source.replace('flag: "--output"', 'flag: "--removed-output"');
  assert.notEqual(mutatedSource, source, 'the mutation must change the canonical native surface');
  fs.writeFileSync(modulePath, mutatedSource);
  try {
    await assert.rejects(
      () => validateNativeDependency(contract, temporaryRoot),
      (caught) => caught?.message === 'native dependency module digest does not match the pinned module'
        && !caught.message.includes(temporaryRoot),
    );

    const repinned = structuredClone(contract);
    repinned.native_dependency.module_sha256 = createHash('sha256')
      .update(mutatedSource)
      .digest('hex');
    await assert.rejects(
      () => validateNativeDependency(repinned, temporaryRoot),
      (caught) => caught?.message === 'native dependency cli options are incompatible'
        && !caught.message.includes(temporaryRoot),
    );
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test('native command contract is a side-effect-free source surface', { skip: !nativeRoot }, () => {
  const source = fs.readFileSync(path.join(nativeRoot, contract.native_dependency.module), 'utf8');
  assert.doesNotMatch(source, /node:child_process|fetch\s*\(|spawn\s*\(|provider|model/i);
});
