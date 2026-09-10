#!/usr/bin/env node
/**
 * Sibling workspace helper. Local-profile module (naia-pj-adk profiles/local).
 *
 * Layout: a personal ADK (a personalised fork of naia-adk) holds projects/, and
 * inside it the team hub and the product repositories sit side by side. The hub
 * is the hub because it knows the others, not because they live under it. Paths
 * in the catalog are therefore ../<id>.
 *
 * The naia-comm original hard-coded one owner and one hub name. Here both come
 * from the catalog, so an instance declares its own and the checks still bite:
 * an entry may only name `<owner>/<id>` at `../<id>`, and it may not name the
 * hub itself, because the hub is where the command runs.
 *
 *   node profiles/local/scripts/workspace.mjs plan   [profile]
 *   node profiles/local/scripts/workspace.mjs doctor [profile]
 *
 * `plan` prints the clone commands for missing siblings; it changes nothing.
 * `doctor` reports whether each sibling is present, independent, clean and on a
 * commit, and exits non-zero when it is not.
 */
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const sha = /^[a-f0-9]{40}$/;

/** Walk up to the enclosing Git repository so the module works wherever it sits. */
export function resolveRoot(explicit = null, from = path.dirname(fileURLToPath(import.meta.url)), env = process.env) {
  if (explicit) return path.resolve(explicit);
  if (env.NAIA_WORKSPACE_ROOT) return path.resolve(env.NAIA_WORKSPACE_ROOT);
  let current = path.resolve(from);
  for (;;) {
    if (fsSync.existsSync(path.join(current, '.git'))) return current;
    const parent = path.dirname(current);
    if (parent === current) throw new Error('cannot find the repository root; set NAIA_WORKSPACE_ROOT');
    current = parent;
  }
}

export function validateCatalog(catalog) {
  if (catalog?.schemaVersion !== 1 || catalog.layout !== 'siblings' || !Array.isArray(catalog.repositories)) {
    throw new Error('Invalid repository catalog');
  }
  const owner = catalog.owner;
  const hub = catalog.hub;
  if (typeof owner !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(owner)) throw new Error('Catalog must declare a GitHub owner');
  if (typeof hub !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(hub)) throw new Error('Catalog must declare the hub repository id');
  const ids = new Set();
  for (const repo of catalog.repositories) {
    if (typeof repo?.id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(repo.id) || repo.id === hub || ids.has(repo.id)
        || repo.repository !== `${owner}/${repo.id}` || repo.path !== `../${repo.id}`
        || typeof repo.branch !== 'string' || repo.branch === '') {
      throw new Error(`Unsafe or duplicate repository entry: ${repo?.id}`);
    }
    ids.add(repo.id);
  }
  for (const members of Object.values(catalog.profiles || {})) {
    if (!Array.isArray(members) || members.some((id) => !ids.has(id))) throw new Error('Invalid profile members');
  }
  return catalog;
}

export function selectRepositories(catalog, profile) {
  validateCatalog(catalog);
  if (!Object.hasOwn(catalog.profiles ?? {}, profile)) throw new Error(`Unknown profile: ${profile}`);
  return catalog.profiles[profile].map((id) => catalog.repositories.find((repo) => repo.id === id));
}

export function plan(catalog, profile) {
  const repos = selectRepositories(catalog, profile);
  return [
    `# Run from the ${catalog.hub} root. Siblings land next to it inside your personal ADK projects/ directory.`,
    '# git clone refuses an occupied destination; nothing existing is changed.',
    ...repos.map((repo) => `git clone --branch ${repo.branch} https://github.com/${repo.repository}.git ${repo.path}`),
    ...(repos.length ? [] : ['# This profile needs no product clones.']),
    '# Cloning proves nothing about build or compatibility; a QA round records the exact SHA combination.',
  ].join('\n');
}

export async function doctor(catalog, profile, workspaceRoot = resolveRoot(), git = defaultGit) {
  const repos = selectRepositories(catalog, profile);
  const base = await fs.realpath(workspaceRoot);
  const heads = {};
  const findings = [];
  for (const repo of repos) {
    const directory = path.resolve(base, repo.path);
    try {
      const stat = await fs.lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('not a directory');
      const top = await git(directory, ['rev-parse', '--show-toplevel']);
      if (path.resolve(top) !== directory) throw new Error('not an independent Git root');
      const origin = await git(directory, ['config', '--get', 'remote.origin.url']).catch(() => '');
      if (!new RegExp(`github\\.com[:/]${repo.repository}(?:\\.git)?$`, 'i').test(origin)) findings.push(`${repo.id}: origin is not ${repo.repository}`);
      const head = await git(directory, ['rev-parse', '--verify', 'HEAD']);
      if (!sha.test(head)) throw new Error('invalid HEAD');
      heads[repo.id] = head;
      if (await git(directory, ['status', '--porcelain'])) findings.push(`${repo.id}: dirty checkout; a round candidate needs a clean commit`);
    } catch {
      findings.push(`${repo.id}: missing sibling checkout at ${repo.path}`);
    }
  }
  // An instance may name one repository whose file records the SHA combination
  // the others are expected to match. When it does, disagreement is a finding.
  const pairing = catalog.pairing;
  if (pairing && heads[pairing.repository]) {
    try {
      const record = JSON.parse(await fs.readFile(path.resolve(base, '..', pairing.repository, pairing.file), 'utf8'));
      for (const [field, id] of Object.entries(pairing.expects ?? {})) {
        if (heads[id] && sha.test(record?.[field] ?? '') && heads[id] !== record[field]) {
          findings.push(`${id}: ${pairing.repository} pairing expects ${record[field]}, checkout is ${heads[id]}`);
        }
      }
    } catch { findings.push(`${pairing.repository}: pairing file missing or malformed`); }
  }
  return { profile, heads, findings, checkoutChecks: findings.length ? 'FAIL' : 'PASS' };
}

async function defaultGit(cwd, args) {
  const { stdout } = await exec('git', ['--no-optional-locks', ...args], { cwd, encoding: 'utf8', timeout: 15000 });
  return stdout.trim();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, profile = 'default'] = process.argv.slice(2);
    if (!['plan', 'doctor'].includes(command)) throw new Error('Usage: node workspace.mjs <plan|doctor> [profile]');
    const root = resolveRoot();
    const catalogPath = process.env.NAIA_WORKSPACE_CATALOG ?? path.join(root, 'workspace/repos.json');
    const catalog = JSON.parse(await fs.readFile(catalogPath, 'utf8'));
    if (command === 'plan') console.log(plan(catalog, profile));
    else { const result = await doctor(catalog, profile, root); console.log(JSON.stringify(result, null, 2)); if (result.findings.length) process.exitCode = 1; }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
