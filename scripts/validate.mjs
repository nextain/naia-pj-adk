import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const required = [
  'AGENTS.md', 'CLAUDE.md', 'GEMINI.md', 'README.md',
  '.agents/context/project-policy.yaml',
  '.agents/context/workflow.yaml',
  '.agents/context/discord.yaml',
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
for (const marker of ['integration_branch:', 'release_owners:', 'production_requires_issue_approval: true']) {
  if (!template.includes(marker)) throw new Error(`project template missing marker: ${marker}`);
}

const participantSchema = JSON.parse(fs.readFileSync(path.join(root, 'schemas/participants.schema.json'), 'utf8'));
if (participantSchema.additionalProperties !== false || !participantSchema.required.includes('participants')) {
  throw new Error('participant schema must reject unknown root fields and require participants');
}

console.log('structure validation passed');
