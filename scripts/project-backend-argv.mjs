#!/usr/bin/env node

import path from 'node:path';
import { buildProjectBackendArgs } from './project-backend-command.mjs';

function fail(message) {
  console.error(`project backend argv rejected: ${message}`);
  process.exitCode = 1;
}

function parseArgs(argv) {
  const options = { commandArgs: [] };
  const valueOptions = new Set([
    '--adapter', '--operation', '--command', '--revision', '--issue-evidence',
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === '--arg') {
      if (index + 1 >= argv.length) throw new Error('each --arg requires a value');
      options.commandArgs.push(argv[++index]);
      continue;
    }
    if (!valueOptions.has(key) || index + 1 >= argv.length) {
      throw new Error('invalid project backend argv arguments');
    }
    const name = key.slice(2).replaceAll('-', '_');
    if (Object.hasOwn(options, name)) throw new Error('duplicate project backend argv option');
    options[name] = argv[++index];
  }
  if (!options.adapter || !options.operation || !options.command) {
    throw new Error('adapter, operation, and command are required');
  }
  return options;
}

try {
  const options = parseArgs(process.argv.slice(2));
  const delegated = buildProjectBackendArgs({
    adapterFile: path.resolve(options.adapter),
    operation: options.operation,
    command: options.command,
    commandArgs: options.commandArgs,
    revision: options.revision,
    issueEvidenceFile: options.issue_evidence,
  });
  for (const token of delegated) process.stdout.write(`${token}\0`);
} catch (error) {
  fail(error instanceof Error ? error.message : 'invalid project backend argv');
}
