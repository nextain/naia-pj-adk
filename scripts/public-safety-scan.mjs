import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const excluded = new Set(['.git', 'node_modules']);
const forbiddenNames = new Set(['.env', 'id_rsa', 'id_ed25519']);
const suspicious = [
  /-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----/,
  /(?:discord(?:_bot)?_token|github_token|password)[ \t]*[:=][ \t]*[^\s"']{8,}/i,
  /https?:\/\/[^\s/@]+:[^\s/@]+@/,
  /\b(?:\d{1,3}\.){3}\d{1,3}\b/
];
const findings = [];

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (excluded.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    const rel = path.relative(root, full);
    if (forbiddenNames.has(entry.name)) findings.push(`${rel}: forbidden filename`);
    if (entry.isDirectory()) walk(full);
    else {
      const data = fs.readFileSync(full);
      if (data.includes(0)) continue;
      const text = data.toString('utf8');
      suspicious.forEach((pattern, index) => {
        if (pattern.test(text)) findings.push(`${rel}: pattern ${index + 1}`);
      });
    }
  }
}

function inspectText(label, text) {
  suspicious.forEach((pattern, index) => {
    if (pattern.test(text)) findings.push(`${label}: pattern ${index + 1}`);
  });
}

function scanReachableHistory() {
  if (!fs.existsSync(path.join(root, '.git'))) return;

  let revisions = [];
  try {
    revisions = execFileSync('git', ['rev-list', '--all'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim().split('\n').filter(Boolean);
  } catch {
    findings.push('git history: unable to enumerate reachable revisions');
    return;
  }

  for (const revision of revisions) {
    const files = execFileSync('git', ['ls-tree', '-r', '--name-only', revision], {
      cwd: root,
      encoding: 'utf8'
    }).trim().split('\n').filter(Boolean);

    for (const file of files) {
      if (file.split('/').some((part) => forbiddenNames.has(part))) {
        findings.push(`history ${revision.slice(0, 12)} ${file}: forbidden filename`);
      }
      let data;
      try {
        data = execFileSync('git', ['show', `${revision}:${file}`], {
          cwd: root,
          encoding: null,
          maxBuffer: 10 * 1024 * 1024,
          stdio: ['ignore', 'pipe', 'ignore']
        });
      } catch {
        findings.push(`history ${revision.slice(0, 12)} ${file}: unable to inspect`);
        continue;
      }
      if (!data.includes(0)) inspectText(`history ${revision.slice(0, 12)} ${file}`, data.toString('utf8'));
    }
  }
}

walk(root);
scanReachableHistory();
if (findings.length) {
  console.error('public-safety scan failed (values intentionally omitted):');
  findings.forEach((item) => console.error(`- ${item}`));
  process.exit(1);
}
console.log('public-safety scan passed');
