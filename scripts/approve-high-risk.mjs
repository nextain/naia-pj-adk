#!/usr/bin/env node
// Human-only: approve one exact high-risk command for a few minutes.
//   node scripts/approve-high-risk.mjs --issue <repo#n> [--minutes 10] [--by name] -- <exact command>
// Writes the lease named in .agents/context/guard-policy.json. Agents are blocked
// from running this file and from touching the lease (protected_paths).
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {sha256, MAX_LEASE_MINUTES} from './lib/pretool-guard.mjs';

const root = path.resolve(process.env.GUARD_ROOT || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
const argv = process.argv.slice(2);
const sep = argv.indexOf('--');
const opts = {};
for (let i = 0; i < (sep < 0 ? argv.length : sep); i += 2) opts[argv[i].replace(/^--/, '')] = argv[i + 1];
const command = sep < 0 ? '' : argv.slice(sep + 1).join(' ');
const fail = (msg) => { process.stderr.write(msg + '\n'); process.exit(1); };

if (!process.stdin.isTTY || !process.stdout.isTTY) fail('Run this yourself in an interactive terminal. It is not for agents.');
if (!command.trim()) fail('Give the exact command after --.');
if (!opts.issue) fail('--issue is required.');
const policy = JSON.parse(fs.readFileSync(path.join(root, '.agents/context/guard-policy.json'), 'utf8'));
const max = policy.lease?.max_minutes ?? MAX_LEASE_MINUTES;
const minutes = Math.min(Number(opts.minutes ?? max), max);
if (!(minutes > 0)) fail('--minutes must be positive.');
const now = new Date();
const lease = {
  command_sha256: sha256(command),
  command_preview: command.trim().slice(0, 200),
  issue: opts.issue,
  approved_by: opts.by ?? process.env.USER ?? 'unknown',
  created_at: now.toISOString(),
  expires_at: new Date(now.getTime() + minutes * 60000).toISOString(),
};
const file = path.join(root, policy.lease.path);
fs.mkdirSync(path.dirname(file), {recursive: true});
fs.writeFileSync(file + '.tmp', JSON.stringify(lease, null, 2) + '\n', {mode: 0o600});
fs.renameSync(file + '.tmp', file);
process.stdout.write(`Approved for ${minutes} min: ${lease.command_preview}\n${file}\n`);
