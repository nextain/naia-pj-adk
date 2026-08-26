import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const required = [
  'AGENTS.md', 'CLAUDE.md', 'GEMINI.md', 'README.md',
  '.agents/context/project-policy.yaml',
  '.agents/context/workflow.yaml',
  '.agents/context/discord.yaml',
  '.agents/context/execution.yaml',
  '.agents/context/development-method.yaml',
  'projects/_template/project.yaml'
];

for (const file of required) {
  if (!fs.existsSync(path.join(root, file))) throw new Error(`missing required file: ${file}`);
}

const canonical = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
for (const mirror of ['CLAUDE.md', 'GEMINI.md']) {
  if (canonical !== fs.readFileSync(path.join(root, mirror), 'utf8')) {
    throw new Error(`AGENTS.md and ${mirror} must be byte-identical`);
  }
}

const template = fs.readFileSync(path.join(root, 'projects/_template/project.yaml'), 'utf8');
for (const marker of [
  'integration_branch:', 'release_owners:', 'production_requires_issue_approval: true',
  // The execution contract is only real if every adapter has to answer it.
  'deploy_gate_command:', 'verification:', 'rollback:', 'drift_check_command:', 'tiers:'
]) {
  if (!template.includes(marker)) throw new Error(`project template missing marker: ${marker}`);
}

// CODEX.md is a pointer, not a byte mirror, so the mirror check above cannot
// cover it. Without this the file could quietly say something AGENTS.md does
// not, and nothing would notice.
const codex = fs.readFileSync(path.join(root, 'CODEX.md'), 'utf8');
if (!codex.includes('AGENTS.md')) {
  throw new Error('CODEX.md must point at AGENTS.md as the canonical entrypoint');
}
if (codex.split('\n').filter((line) => line.trim()).length > 6) {
  throw new Error('CODEX.md must stay a pointer; put rules in AGENTS.md so all tools read one text');
}

// Every actor named by a transition must be a role the policy actually grants.
const workflow = fs.readFileSync(path.join(root, '.agents/context/workflow.yaml'), 'utf8');
const policy = fs.readFileSync(path.join(root, '.agents/context/project-policy.yaml'), 'utf8');
const declaredStates = new Set(
  workflow.split('transitions:')[0].split('\n')
    .map((line) => line.match(/^\s+-\s+(\w+)\s*$/)).filter(Boolean).map((m) => m[1])
);
for (const [, state] of workflow.matchAll(/(?:from|to):\s*(\w+)/g)) {
  if (!declaredStates.has(state)) throw new Error(`workflow references undeclared state: ${state}`);
}
for (const [, actor] of workflow.matchAll(/actor:\s*(\w+)/g)) {
  if (!new RegExp(`^\\s{2}${actor}:`, 'm').test(policy)) {
    throw new Error(`workflow transition names a role the policy does not define: ${actor}`);
  }
}

// The execution contract must keep naming the things that cost outages when
// they are missing. These keys are load-bearing, not decoration.
const execution = fs.readFileSync(path.join(root, '.agents/context/execution.yaml'), 'utf8');
for (const key of ['deploy_gate', 'artifact', 'propagation', 'verification', 'rollback', 'concurrency', 'drift', 'watchdog', 'environment_tiers', 'completion']) {
  if (!new RegExp(`^${key}:`, 'm').test(execution)) {
    throw new Error(`execution contract missing top-level section: ${key}`);
  }
}
if (!execution.includes('ai_may_not_declare_completion: true')) {
  throw new Error('execution contract must keep completion a human decision');
}
for (const rule of ['one_item_may_not_stop_the_sweep: true', 'own_failure_must_alarm: true']) {
  if (!execution.includes(rule)) throw new Error(`execution contract must keep the watchdog rule: ${rule}`);
}

// The development method must keep naming the axes that large tasks skip.
const method = fs.readFileSync(path.join(root, '.agents/context/development-method.yaml'), 'utf8');
for (const key of ['vocabulary', 'change_classification', 'use_case', 'feature_spec', 'tests', 'independent_review', 'shared_data']) {
  if (!new RegExp(`^${key}:`, 'm').test(method)) {
    throw new Error(`development method missing top-level section: ${key}`);
  }
}
if (!method.includes('undefined_term_behavior: ask, never infer')) {
  throw new Error('development method must keep an undefined term a question, not a guess');
}

// An adapter that still carries template placeholders, or that claims a
// reachable tier without the commands that guard it, is not activated. Saying
// so in prose was not enough: the previous validator accepted both.
const projectsDir = path.join(root, 'projects');
for (const entry of fs.readdirSync(projectsDir, { withFileTypes: true })) {
  if (!entry.isDirectory() || entry.name === '_template') continue;
  const file = path.join(projectsDir, entry.name, 'project.yaml');
  if (!fs.existsSync(file)) throw new Error(`adapter ${entry.name} has no project.yaml`);
  const adapter = fs.readFileSync(file, 'utf8');
  for (const placeholder of ['replace-me', 'replace.example', 'replace-with-']) {
    if (adapter.includes(placeholder)) {
      throw new Error(`adapter ${entry.name} still carries the placeholder ${placeholder}`);
    }
  }
  // A tier declared reachable is a tier people will deploy to.
  const reachable = /reachable:\s*true/.test(adapter);
  if (reachable) {
    for (const command of ['deploy_gate_command', 'drift_check_command']) {
      if (new RegExp(`${command}:\\s*null`).test(adapter)) {
        throw new Error(`adapter ${entry.name} declares a reachable tier but leaves ${command} null`);
      }
    }
    if (/command:\s*null/.test(adapter.split('verification:')[1] ?? '')) {
      throw new Error(`adapter ${entry.name} declares a reachable tier but has no verification command`);
    }
  }
}

// Harness and session state must never become tracked history.
const ignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
for (const rule of ['.agents/session-contracts/', '.agents/harness/']) {
  if (!ignore.includes(rule)) throw new Error(`.gitignore must exclude tool state: ${rule}`);
}

const participantSchema = JSON.parse(fs.readFileSync(path.join(root, 'schemas/participants.schema.json'), 'utf8'));
if (participantSchema.additionalProperties !== false || !participantSchema.required.includes('participants')) {
  throw new Error('participant schema must reject unknown root fields and require participants');
}

console.log('structure validation passed');
