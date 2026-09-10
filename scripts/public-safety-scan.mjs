import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// Publication gate. This runs before the repository may become public, so a
// pattern that is merely plausible is not enough: it has to catch the shapes
// secrets actually take. An earlier version matched only a literal
// `password=` and a dotted quad, and let a Discord bot token, an AWS key, a
// bearer token, a Korean-labelled password and an IPv6 address through.
//
// False positives are cheap here. A scan that fails on a version string costs
// one exclusion; a scan that misses a token costs a rotation.

const root = path.resolve(import.meta.dirname, '..');
const excluded = new Set(['.git', 'node_modules']);
const forbiddenNames = new Set([
  // public-safety-allow: filenames, not hostnames
  '.env', '.env.local', '.env.production',
  'id_rsa', 'id_ed25519', 'id_ecdsa', 'id_dsa',
  '.netrc', '.npmrc', '.pgpass', 'credentials', 'authorized_keys', 'known_hosts',
  'service-account.json', 'gha-creds.json'
]);

const suspicious = [
  { id: 'private-key-block', re: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/ },
  { id: 'ssh-public-key', re: /\bssh-(?:rsa|ed25519|dss)\s+AAAA[0-9A-Za-z+/]{20,}/ },
  { id: 'credentials-in-url', re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@/i },

  // Labelled secrets. The label list is deliberately broad and includes the
  // Korean words that appear in this project's own documents.
  {
    id: 'labelled-secret',
    re: /\b(?:pass(?:word|wd|phrase)?|secret|client[_-]?secret|token|access[_-]?token|refresh[_-]?token|api[_-]?key|apikey|private[_-]?key|auth|credential|bearer)\b\s*[:=]\s*["']?[^\s"',;]{8,}/i
  },
  { id: 'labelled-secret-ko', re: /(?:비밀번호|비밀\s?키|암호|토큰|자격\s?증명)\s*[:=]\s*["']?\S{6,}/ },

  // Provider-shaped values that need no label to be dangerous.
  { id: 'aws-access-key', re: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA)[0-9A-Z]{16}\b/ },
  { id: 'github-token', re: /\bgh[pousr]_[0-9A-Za-z]{30,}\b/ },
  { id: 'slack-token', re: /\bxox[abprs]-[0-9A-Za-z-]{10,}\b/ },
  { id: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{30,}\b/ },
  { id: 'openai-key', re: /\bsk-(?:live-|proj-)?[0-9A-Za-z_-]{16,}\b/ },
  { id: 'jwt', re: /\beyJ[0-9A-Za-z_-]{10,}\.[0-9A-Za-z_-]{10,}\.[0-9A-Za-z_-]{10,}\b/ },
  // Discord bot tokens are three dot-separated base64 segments beginning with
  // the base64 of a snowflake.
  { id: 'discord-bot-token', re: /\b[MNO][0-9A-Za-z_-]{22,}\.[0-9A-Za-z_-]{6}\.[0-9A-Za-z_-]{25,}\b/ },

  // Addresses and hosts. The policy forbids private hosts and IP addresses in
  // tracked files, so both families are matched.
  { id: 'ipv4', re: /\b(?:\d{1,3}\.){3}\d{1,3}\b/ },
  { id: 'ipv6', re: /(?<![0-9A-Za-z:])(?:[0-9A-Fa-f]{1,4}:){2,7}(?::|[0-9A-Fa-f]{1,4})(?![0-9A-Za-z:])/ },
  { id: 'internal-hostname', re: /\b[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.(?:internal|intranet|corp|lan|local|localdomain)\b/i },

  // People. The policy forbids personal ids and customer data in tracked files,
  // and an earlier version detected only Discord snowflakes, so an email address
  // or a phone number passed while the policy said they must not.
  { id: 'discord-snowflake', re: /\b(?:discord[^\n]{0,24})\b\D(1[0-9]{16,18}|[2-9][0-9]{16,18})\b/i },
  { id: 'email-address', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/ },
  { id: 'phone-e164', re: /(?<![\w.])\+[1-9]\d{7,14}(?![\w.])/ },
  { id: 'phone-kr', re: /(?<![\w.-])01[0-9][-\s]?\d{3,4}[-\s]?\d{4}(?![\w.-])/ },
  { id: 'korean-rrn', re: /(?<![\w-])\d{6}[-\s]?[1-4]\d{6}(?![\w-])/ },
  { id: 'credit-card', re: /(?<![\w-])(?:\d[ -]?){13,19}(?![\w-])/ }
];

// What this scan claims to cover. A gate that does not say what it looks for
// gets quoted as if it looked for everything.
export const COVERAGE = [
  'private key blocks and SSH public keys',
  'credentials embedded in URLs',
  'labelled secrets in English and Korean',
  'provider-shaped tokens: AWS, GitHub, Slack, Google, OpenAI, JWT, Discord bot',
  'IPv4, IPv6, and internal hostnames',
  'personal identifiers: Discord snowflake, email, phone, resident registration, card-shaped digits',
  'commit messages, where only a Co-Authored-By noreply trailer is exempt',
];

// Lines a maintainer has justified in place. The marker records that a human
// looked at it, which is the only reason a publication gate may stay quiet.
const ALLOW_MARKER = 'public-safety-allow:';

// These reachable commit messages carry public co-author attribution from the
// original review record. The commits are retained verbatim; the allow-list
// records the narrow, human-reviewed exception without weakening email
// detection for the working tree or for other history.
const ALLOWED_REACHABLE_HISTORY = new Set([
  'e2bf97d397debb6fd8b40bfcb8ef91c50de68e1e:email-address',
  'fc85c1e1118761a604105352f87d951c51518533:email-address',
  '15dc1191c5113b05fdf7d5b27e44c56c4d8e7771:email-address',
]);

// The three revisions above were allow-listed one SHA at a time for the same
// reason: a co-author trailer carries a public no-reply address, which is an
// attribution and not a way to reach a person. Listing SHAs does not survive
// the history it describes. A rebase, a squash merge or an amended message
// gives every one of those commits a new SHA, the exception stops applying,
// and the gate fails on a line a maintainer already reviewed.
//
// So the exception is written as the shape it actually is, exactly once. It is
// deliberately narrow: only a Co-Authored-By trailer, only a noreply address,
// and only in a commit message, where a trailer is the only place this form
// appears. An address in a tracked file is still a finding.
const CO_AUTHOR_TRAILER = /^\s*co-authored-by:\s*[^<>]+<([^<>\s]+)>\s*$/i;
const NOREPLY_ADDRESS = /(?:^|[.@])noreply(?:[.@]|$)/i;

/** A co-author trailer whose address is a no-reply one, in a commit message. */
function isCoAuthorNoreply(line) {
  const trailer = line.match(CO_AUTHOR_TRAILER);
  return Boolean(trailer) && NOREPLY_ADDRESS.test(trailer[1]);
}

const findings = [];

function inspectText(label, text, historyRevision = undefined) {
  const lines = text.split('\n');
  for (const { id, re } of suspicious) {
    for (let i = 0; i < lines.length; i++) {
      if (!re.test(lines[i])) continue;
      const context = `${lines[i - 1] ?? ''}\n${lines[i]}`;
      // historyRevision is set for commit messages only, never for file blobs.
      if (context.includes(ALLOW_MARKER)
          || (historyRevision && ALLOWED_REACHABLE_HISTORY.has(`${historyRevision}:${id}`))
          || (historyRevision && id === 'email-address' && isCoAuthorNoreply(lines[i]))) continue;
      findings.push(`${label}:${i + 1}: ${id}`);
      break;
    }
  }
}

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (excluded.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    const rel = path.relative(root, full);
    if (forbiddenNames.has(entry.name)) findings.push(`${rel}: forbidden filename`);
    if (entry.isDirectory()) { walk(full); continue; }
    const data = fs.readFileSync(full);
    if (data.includes(0)) continue;
    inspectText(rel, data.toString('utf8'));
  }
}

function scanReachableHistory() {
  if (!fs.existsSync(path.join(root, '.git'))) return;

  let revisions = [];
  try {
    // --all covers branches and tags. Reflog entries and dangling objects are
    // not published by a clone, so they are out of scope here and belong to
    // the pre-publication garbage-collection step instead.
    revisions = execFileSync('git', ['rev-list', '--all'], {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']
    }).trim().split('\n').filter(Boolean);
  } catch {
    findings.push('git history: unable to enumerate reachable revisions');
    return;
  }

  // Commit messages travel with the history and have carried secrets before.
  for (const revision of revisions) {
    try {
      const message = execFileSync('git', ['log', '-1', '--format=%B', revision], {
        cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']
      });
      inspectText(`history ${revision.slice(0, 12)} <commit message>`, message, revision);
    } catch {
      findings.push(`history ${revision.slice(0, 12)}: unable to read commit message`);
    }

    let files = [];
    try {
      files = execFileSync('git', ['ls-tree', '-r', '--name-only', revision], {
        cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']
      }).trim().split('\n').filter(Boolean);
    } catch {
      findings.push(`history ${revision.slice(0, 12)}: unable to list files`);
      continue;
    }

    for (const file of files) {
      if (file.split('/').some((part) => forbiddenNames.has(part))) {
        findings.push(`history ${revision.slice(0, 12)} ${file}: forbidden filename`);
      }
      // A gitlink records only a referenced commit ID, so this repository
      // cannot inspect the child tree or history. Fail closed even when the
      // gitlink exists only in reachable history.
      const treeEntry = execFileSync('git', ['ls-tree', revision, '--', file], {
        cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']
      });
      if (treeEntry.startsWith('160000 ')) {
        findings.push(`history ${revision.slice(0, 12)} ${file}: unverified gitlink`);
        continue;
      }
      let data;
      try {
        data = execFileSync('git', ['show', `${revision}:${file}`], {
          cwd: root, encoding: null, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore']
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
  console.error(`\nIf a match is genuinely safe, put \`${ALLOW_MARKER} <reason>\` on the line above it.`);
  process.exit(1);
}
console.log(`public-safety scan passed (${suspicious.length} patterns, tree and reachable history)`);
console.log(`covered: ${COVERAGE.join('; ')}`);
