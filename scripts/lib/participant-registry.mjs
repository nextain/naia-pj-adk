import { normalizeMutationWindow } from './mutation-window.mjs';

const PARTICIPANT_FIELDS = [
  'discordUserId', 'alias', 'project', 'workspace', 'roles', 'enabled', 'mutationWindow',
];
const REQUIRED_FIELDS = ['discordUserId', 'alias', 'project', 'workspace', 'roles'];
const ALIAS_PATTERN = /^[a-z0-9][a-z0-9_-]{1,31}$/;
const SNOWFLAKE_PATTERN = /^[0-9]{17,20}$/;

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * Validate the ignored runtime participant registry without ever echoing a
 * registry value. The registry is an authentication-to-workspace projection,
 * so accepting a malformed row would turn a routing mistake into an
 * authority decision made by whichever row happened to be read first.
 */
export function validateParticipantRegistry(registry) {
  const problems = [];
  if (!isObject(registry)) {
    return ['registry root must be an object'];
  }
  if (!Array.isArray(registry.participants)) {
    problems.push('participants must be an array');
    return problems;
  }

  for (const key of Object.keys(registry)) {
    if (key !== 'participants') problems.push(`unknown root field: ${key}`);
  }

  const aliasSeen = new Map();
  const senderSeen = new Map();
  registry.participants.forEach((entry, index) => {
    const at = `participants[${index}]`;
    if (!isObject(entry)) {
      problems.push(`${at}: must be an object`);
      return;
    }
    for (const field of REQUIRED_FIELDS) {
      if (!Object.hasOwn(entry, field)) problems.push(`${at}: missing ${field}`);
    }
    for (const field of Object.keys(entry)) {
      if (!PARTICIPANT_FIELDS.includes(field)) problems.push(`${at}: unknown field ${field}`);
    }
    for (const field of ['discordUserId', 'alias', 'project', 'workspace']) {
      if (Object.hasOwn(entry, field) && !isNonEmptyString(entry[field])) {
        problems.push(`${at}: ${field} must be a non-empty string`);
      }
    }
    if (typeof entry.discordUserId === 'string' && !SNOWFLAKE_PATTERN.test(entry.discordUserId)) {
      problems.push(`${at}: discordUserId is not a snowflake`);
    }
    if (typeof entry.alias === 'string' && !ALIAS_PATTERN.test(entry.alias)) {
      problems.push(`${at}: alias does not match the required shape`);
    }
    if (Object.hasOwn(entry, 'roles')) {
      if (!Array.isArray(entry.roles) || entry.roles.length === 0) {
        problems.push(`${at}: roles must be a non-empty array`);
      } else {
        const rolesSeen = new Set();
        entry.roles.forEach((role, roleIndex) => {
          if (!isNonEmptyString(role)) {
            problems.push(`${at}.roles[${roleIndex}] must be a non-empty string`);
          } else if (rolesSeen.has(role)) {
            problems.push(`${at}.roles[${roleIndex}] repeats a role`);
          } else {
            rolesSeen.add(role);
          }
        });
      }
    }
    if (Object.hasOwn(entry, 'enabled') && typeof entry.enabled !== 'boolean') {
      problems.push(`${at}: enabled must be boolean`);
    }
    if (Object.hasOwn(entry, 'mutationWindow')) {
      try {
        normalizeMutationWindow(entry.mutationWindow);
      } catch {
        problems.push(`${at}: mutationWindow is invalid`);
      }
    }

    if (entry.enabled === false) return;
    if (isNonEmptyString(entry.alias) && isNonEmptyString(entry.project)) {
      const aliasKey = `${entry.project}\u0000${entry.alias}`;
      if (aliasSeen.has(aliasKey)) {
        problems.push(`${at}: alias repeats within the project (also participants[${aliasSeen.get(aliasKey)}])`);
      } else {
        aliasSeen.set(aliasKey, index);
      }
    }
    if (isNonEmptyString(entry.discordUserId) && isNonEmptyString(entry.project)) {
      const senderKey = `${entry.project}\u0000${entry.discordUserId}`;
      if (senderSeen.has(senderKey)) {
        problems.push(`${at}: sender already has a workspace in this project (also participants[${senderSeen.get(senderKey)}])`);
      } else {
        senderSeen.set(senderKey, index);
      }
    }
  });
  return problems;
}

export function activeParticipantsForProject(registry, projectId) {
  return registry.participants.filter((entry) => entry.enabled !== false && entry.project === projectId);
}
