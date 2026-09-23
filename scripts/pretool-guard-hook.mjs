#!/usr/bin/env node
// PreToolUse adapter for Claude Code and Grok (Grok maps Bash to run_terminal_command).
// Exit 2 with a reason on stderr blocks the call in both tools.
// Root = GUARD_ROOT, else the repository that contains this file.
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {evaluateCommand, evaluateEdit, verdict, MAX_LEASE_MINUTES} from './lib/pretool-guard.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const guardRoot = path.resolve(process.env.GUARD_ROOT || path.join(here, '..'));

function git(cwd, args) {
  try { return execFileSync('git', ['-C', cwd, ...args], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']}).trim(); } catch { return ''; }
}
function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function main() {
  let data;
  try { data = JSON.parse(fs.readFileSync(0, 'utf8')); } catch { return 0; }
  const tool = String(data.tool_name ?? data.toolName ?? '');
  const input = data.tool_input ?? data.toolInput ?? {};
  const cwd = path.resolve(String(data.cwd ?? process.cwd()));
  const policy = readJson(path.join(guardRoot, '.agents/context/guard-policy.json')) ?? {};
  const ctx = {
    cwd,
    repoRoot: git(cwd, ['rev-parse', '--show-toplevel']) || guardRoot,
    currentBranch: git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']),
    home: process.env.HOME,
    readFile: (file) => { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } },
  };
  const command = input.command ?? input.cmd;
  let result;
  if (typeof command === 'string') {
    result = evaluateCommand(command, ctx, policy);
  } else if (/^(Edit|Write|MultiEdit|NotebookEdit|apply_patch|search_replace|write|edit_file)$/i.test(tool)) {
    const file = input.file_path ?? input.filePath ?? input.path ?? input.notebook_path;
    result = typeof file === 'string'
      ? evaluateEdit(file, {...ctx, repoRoot: guardRoot}, policy)
      : evaluateCommand(JSON.stringify(input), {...ctx, currentBranch: ''}, {protected_paths: policy.protected_paths});
  } else {
    return 0;
  }
  const leasePath = policy.lease?.path ? path.join(guardRoot, policy.lease.path) : null;
  const v = verdict(result, command ?? '', leasePath ? readJson(leasePath) : null, Date.now(), policy.lease?.max_minutes ?? MAX_LEASE_MINUTES);
  if (!v.block) return 0;
  process.stderr.write(v.reason + '\n');
  return 2;
}

let code = 0;
try { code = main(); } catch (error) {
  process.stderr.write(`[guard] internal error, not blocking: ${error?.message ?? error}\n`);
  code = 0;
}
process.exit(code);
