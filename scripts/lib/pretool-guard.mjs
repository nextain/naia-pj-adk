// PreToolUse guard engine. Tool-agnostic and dependency-free (node built-ins only).
//
// A permission mode such as always-approve decides whether the user is asked.
// This engine decides whether a command may run at all. It returns
//   {decision: 'allow'}
//   {decision: 'deny', rule, reason}      never runs from an agent
//   {decision: 'approval', rule, reason}  runs only with a valid approval lease
// The adapter turns a deny, or an approval without a valid lease, into a block.
import crypto from 'node:crypto';
import path from 'node:path';

export const DEFAULT_PROTECTED_BRANCHES = ['main', 'master'];
export const DEFAULT_CATASTROPHIC_TARGETS = ['/', '/*', '~', '~/', '$HOME', '${HOME}', '/home', '/opt', '/var', '/etc', '/usr', '/srv', '/root', '/storage'];
export const MAX_LEASE_MINUTES = 15;

export function sha256(text) {
  return crypto.createHash('sha256').update(String(text).trim()).digest('hex');
}

// Split a command line into simple commands. Quotes are respected so that a
// commit message mentioning `git push origin main` is not read as a push.
export function splitCommands(command) {
  const segments = [];
  let current = [];
  let token = '';
  let hasToken = false;
  let quote = null;
  const pushToken = () => { if (hasToken) current.push(token); token = ''; hasToken = false; };
  const pushSegment = () => { pushToken(); if (current.length) segments.push(current); current = []; };
  const text = String(command ?? '');
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === '\\' && quote === '"' && i + 1 < text.length) { token += text[++i]; }
      else token += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; hasToken = true; continue; }
    if (ch === '\\' && i + 1 < text.length) { token += text[++i]; hasToken = true; continue; }
    if (ch === ' ' || ch === '\t') { pushToken(); continue; }
    if (ch === '\n' || ch === ';' || ch === '|' || ch === '&' || ch === '(' || ch === ')' || ch === '`') { pushSegment(); continue; }
    if (ch === '$' && text[i + 1] === '(') { pushSegment(); i += 1; continue; }
    token += ch;
    hasToken = true;
  }
  pushSegment();
  return segments;
}

// Drop leading wrappers so `sudo -E timeout 60 env A=1 git push` is seen as git.
function stripWrappers(tokens) {
  let t = tokens.slice();
  for (let guard = 0; guard < 20 && t.length; guard += 1) {
    const head = path.basename(t[0]);
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t[0])) { t = t.slice(1); continue; }
    if (['sudo', 'doas', 'env', 'nohup', 'setsid', 'nice', 'ionice', 'stdbuf', 'command', 'exec', 'time'].includes(head)) {
      t = t.slice(1);
      while (t.length && t[0].startsWith('-')) {
        const flag = t[0];
        t = t.slice(1);
        if (['-u', '-g', '-C', '-n', '-c'].includes(flag) && t.length) t = t.slice(1);
      }
      continue;
    }
    if (head === 'timeout') {
      t = t.slice(1);
      while (t.length && t[0].startsWith('-')) t = t.slice(1);
      if (t.length) t = t.slice(1);
      continue;
    }
    break;
  }
  return t;
}

function branchName(ref, currentBranch) {
  let r = ref.replace(/^refs\/heads\//, '');
  if (r === 'HEAD' || r === '@') r = currentBranch || '';
  return r;
}

export function gitPushViolation(tokens, ctx, protectedBranches) {
  const t = stripWrappers(tokens);
  if (!t.length || path.basename(t[0]) !== 'git') return null;
  let i = 1;
  while (i < t.length && t[i].startsWith('-')) {
    if (['-C', '-c', '--git-dir', '--work-tree', '--namespace'].includes(t[i])) i += 2;
    else i += 1;
  }
  if (t[i] !== 'push') return null;
  const args = t.slice(i + 1);
  const positional = [];
  let remoteByFlag = false;
  for (let k = 0; k < args.length; k += 1) {
    const a = args[k];
    if (a === '--') { positional.push(...args.slice(k + 1)); break; }
    if (/^--force(-with-lease|-if-includes)?(=.*)?$/.test(a) || /^-[A-Za-z]*f[A-Za-z]*$/.test(a) && !a.startsWith('--')) {
      return {rule: 'git-force-push', reason: 'Force push rewrites remote history.'};
    }
    if (a === '--delete' || /^-[A-Za-z]*d[A-Za-z]*$/.test(a) && !a.startsWith('--') || a === '--prune') {
      return {rule: 'git-remote-delete', reason: 'Deleting remote branches or tags is hard to undo.'};
    }
    if (a === '--all' || a === '--mirror') {
      return {rule: 'git-push-all', reason: `${a} pushes every branch, including protected ones.`};
    }
    if (a === '--repo' || a.startsWith('--repo=')) { remoteByFlag = true; if (a === '--repo') k += 1; continue; }
    if (['-o', '--push-option', '--receive-pack', '--exec'].includes(a)) { k += 1; continue; }
    if (a.startsWith('-')) continue;
    positional.push(a);
  }
  const refspecs = remoteByFlag ? positional : positional.slice(1);
  if (!refspecs.length) {
    const current = ctx.currentBranch || '';
    if (protectedBranches.includes(current)) {
      return {rule: 'git-push-protected', reason: `The current branch ${current} is protected; its default push goes straight to ${current}.`};
    }
    return null;
  }
  for (const spec of refspecs) {
    if (spec.startsWith('+')) return {rule: 'git-force-push', reason: `Refspec ${spec} forces the update.`};
    if (spec.startsWith(':')) return {rule: 'git-remote-delete', reason: `Refspec ${spec} deletes a remote ref.`};
    const dst = branchName(spec.includes(':') ? spec.slice(spec.indexOf(':') + 1) : spec, ctx.currentBranch);
    if (protectedBranches.includes(dst)) {
      return {rule: 'git-push-protected', reason: `Direct push to protected branch ${dst}. Merge through a reviewed pull request.`};
    }
  }
  return null;
}

export function catastrophicDeleteViolation(tokens, ctx, targets) {
  const t = stripWrappers(tokens);
  if (!t.length || path.basename(t[0]) !== 'rm') return null;
  let recursive = false;
  const operands = [];
  let endOfFlags = false;
  for (const a of t.slice(1)) {
    if (!endOfFlags && a === '--') { endOfFlags = true; continue; }
    if (!endOfFlags && a === '--no-preserve-root') return {rule: 'catastrophic-delete', reason: 'rm --no-preserve-root.'};
    if (!endOfFlags && (a === '--recursive' || /^-[A-Za-z]*[rR][A-Za-z]*$/.test(a))) { recursive = true; continue; }
    if (!endOfFlags && a.startsWith('-')) continue;
    operands.push(a);
  }
  if (!recursive) return null;
  const root = ctx.repoRoot ? path.resolve(ctx.repoRoot) : null;
  const home = ctx.home ? path.resolve(ctx.home) : null;
  for (const op of operands) {
    const plain = op.replace(/\/+$/, '') || '/';
    if (targets.includes(op) || targets.includes(plain)) return {rule: 'catastrophic-delete', reason: `Recursive delete of ${op}.`};
    if (!ctx.cwd) continue;
    const expanded = op.replace(/^~(?=\/|$)/, home || '~').replace(/^\$\{?HOME\}?(?=\/|$)/, home || '$HOME');
    const abs = path.resolve(ctx.cwd, expanded.replace(/(^|\/)\*$/, '$1') || '.');
    if (home && abs === home) return {rule: 'catastrophic-delete', reason: `Recursive delete of the home directory (${op}).`};
    if (root && abs === path.join(root, '.git')) return {rule: 'catastrophic-delete', reason: `Recursive delete of the repository history (${op}).`};
    if (root && (abs === root || root.startsWith(abs + path.sep))) {
      return {rule: 'catastrophic-delete', reason: `Recursive delete of the repository root or a parent of it (${op}).`};
    }
  }
  return null;
}

function compile(rule) {
  return new RegExp(rule.pattern, rule.flags ?? 'i');
}

// The command's structure with free text (a quoted argument containing
// whitespace, such as a commit message) replaced by a placeholder. Text passed
// to `sh -c` / `bash -c` stays, because it is itself a command.
export function structureText(command) {
  return splitCommands(command)
    .map((tokens) => tokens.map((tok, i) => (/\s/.test(tok) && tokens[i - 1] !== '-c' ? '"…"' : tok)).join(' '))
    .join(' ; ');
}

// A rule matches the full text by default; `"match": "structure"` ignores free text.
function firstMatch(rules, text) {
  let structure = null;
  for (const rule of rules ?? []) {
    const subject = rule.match === 'structure' ? (structure ??= structureText(text)) : text;
    if (compile(rule).test(subject)) return rule;
  }
  return null;
}

// Remote-execution commands carry the real action in a script. Read it and
// apply the same content patterns. An unreadable script cannot be cleared.
function inspectScripts(command, ctx, policy) {
  for (const rule of policy.inspect_scripts ?? []) {
    if (!compile({pattern: rule.command_pattern, flags: rule.flags}).test(command)) continue;
    // script_pattern: regex whose first matching capture group is the script file.
    const ref = command.match(new RegExp(rule.script_pattern ?? `--scripts?\\s+@(?:"([^"]+)"|'([^']+)'|(\\S+))`));
    let content = null;
    const file = ref ? ref.slice(1).find((g) => g !== undefined) : undefined;
    if (file !== undefined) {
      content = ctx.readFile ? ctx.readFile(path.resolve(ctx.cwd || '.', file)) : null;
      if (content == null) {
        return {decision: 'approval', rule: rule.id, reason: `${rule.reason} The script ${file} could not be read, so it cannot be cleared.`};
      }
    } else {
      const inline = command.match(/--scripts?\s+([\s\S]*)$/);
      content = inline ? inline[1] : command;
    }
    const denied = firstMatch(rule.content_deny, content);
    if (denied) return {decision: 'deny', rule: `${rule.id}:${denied.id}`, reason: `${rule.reason} ${denied.reason}`};
    const needs = firstMatch(rule.content_approval, content);
    if (needs) return {decision: 'approval', rule: `${rule.id}:${needs.id}`, reason: `${rule.reason} ${needs.reason}`};
  }
  return null;
}

export function leaseCovers(lease, command, now = Date.now(), maxMinutes = MAX_LEASE_MINUTES) {
  if (!lease || typeof lease !== 'object') return {ok: false, why: 'no approval lease'};
  const created = Date.parse(lease.created_at);
  const expires = Date.parse(lease.expires_at);
  if (!Number.isFinite(created) || !Number.isFinite(expires)) return {ok: false, why: 'lease timestamps are invalid'};
  if (expires - created > maxMinutes * 60000) return {ok: false, why: `lease longer than ${maxMinutes} minutes`};
  if (now < created || now >= expires) return {ok: false, why: 'lease expired'};
  if (lease.command_sha256 !== sha256(command)) return {ok: false, why: 'lease was approved for a different command'};
  return {ok: true};
}

export function evaluateCommand(command, ctx = {}, policy = {}) {
  const text = String(command ?? '');
  const protectedBranches = policy.protected_branches ?? DEFAULT_PROTECTED_BRANCHES;
  const targets = policy.catastrophic_delete_targets ?? DEFAULT_CATASTROPHIC_TARGETS;
  for (const tokens of splitCommands(text)) {
    const push = gitPushViolation(tokens, ctx, protectedBranches);
    if (push) return {decision: 'deny', ...push};
    const del = catastrophicDeleteViolation(tokens, ctx, targets);
    if (del) return {decision: 'deny', ...del};
  }
  const structure = structureText(text);
  for (const p of policy.protected_paths ?? []) {
    if (structure.includes(p)) return {decision: 'deny', rule: 'protected-path', reason: `${p} is reserved for a human. Agents may not read, write or run it.`};
  }
  const denied = firstMatch(policy.deny, text);
  if (denied) return {decision: 'deny', rule: denied.id, reason: denied.reason};
  const inspected = inspectScripts(text, ctx, policy);
  if (inspected) return inspected;
  const needs = firstMatch(policy.approval, text);
  if (needs) return {decision: 'approval', rule: needs.id, reason: needs.reason};
  return {decision: 'allow'};
}

export function evaluateEdit(filePath, ctx = {}, policy = {}) {
  const abs = path.resolve(ctx.cwd || '.', String(filePath ?? ''));
  for (const p of policy.protected_paths ?? []) {
    const target = path.resolve(ctx.repoRoot || ctx.cwd || '.', p);
    if (abs === target || abs.endsWith(path.sep + p) || abs.startsWith(target + path.sep)) {
      return {decision: 'deny', rule: 'protected-path', reason: `${p} is reserved for a human.`};
    }
  }
  return {decision: 'allow'};
}

// Final verdict for an adapter: block unless allowed or covered by a lease.
export function verdict(result, command, lease, now = Date.now(), maxMinutes = MAX_LEASE_MINUTES) {
  if (result.decision === 'allow') return {block: false};
  if (result.decision === 'deny') return {block: true, reason: `[guard:${result.rule}] ${result.reason}`};
  const cover = leaseCovers(lease, command, now, maxMinutes);
  if (cover.ok) return {block: false, approved: true};
  return {
    block: true,
    reason: `[guard:${result.rule}] ${result.reason} This needs human approval (${cover.why}). ` +
      'Ask the user to approve this exact command in their own terminal, then retry the same command unchanged.',
  };
}
