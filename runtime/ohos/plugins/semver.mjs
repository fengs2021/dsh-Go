// Minimal dependency-free semver: parse, compare, and npm-style range matching.
// Supports the subset plugins use: exact, caret, tilde, comparison, x-ranges,
// hyphen ranges, and "||" unions. Prerelease versions only match a range that
// names a prerelease on the same major.minor.patch, as npm does.

const VERSION = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
const PARTIAL = /^v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-([0-9A-Za-z.-]+))?$/;
const OPERATOR = /^(\^|~>?|>=|<=|>|<|=)?\s*(.*)$/;

const isNumeric = (text) => /^[0-9]+$/.test(text);

/** Parse a full version, or null when the text is not one. */
export function parseVersion(text) {
  if (typeof text !== 'string') return null;
  const match = VERSION.exec(text.trim());
  if (match === null) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] === undefined ? [] : match[4].split('.'),
  };
}

function compareIdentifiers(left, right) {
  const leftNumeric = isNumeric(left);
  const rightNumeric = isNumeric(right);
  if (leftNumeric && rightNumeric) return Number(left) - Number(right);
  if (leftNumeric) return -1;
  if (rightNumeric) return 1;
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/** Compare two versions; -1, 0 or 1. Throws on unparseable input. */
export function compareVersions(left, right) {
  const a = typeof left === 'string' ? parseVersion(left) : left;
  const b = typeof right === 'string' ? parseVersion(right) : right;
  if (a === null || a === undefined || b === null || b === undefined) {
    throw new Error('not a version: ' + String(left) + ' or ' + String(right));
  }
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  const leftPre = a.prerelease ?? [];
  const rightPre = b.prerelease ?? [];
  if (leftPre.length === 0 && rightPre.length === 0) return 0;
  if (leftPre.length === 0) return 1;
  if (rightPre.length === 0) return -1;
  const length = Math.max(leftPre.length, rightPre.length);
  for (let index = 0; index < length; index += 1) {
    if (leftPre[index] === undefined) return -1;
    if (rightPre[index] === undefined) return 1;
    const order = compareIdentifiers(String(leftPre[index]), String(rightPre[index]));
    if (order !== 0) return order < 0 ? -1 : 1;
  }
  return 0;
}

function partialOf(text) {
  const match = PARTIAL.exec(String(text).trim());
  if (match === null) return null;
  const field = (value) => value === undefined || value === 'x' || value === 'X' || value === '*' ? undefined : Number(value);
  const major = field(match[1]);
  const minor = field(match[2]);
  const patch = field(match[3]);
  if (major === undefined) return { major: 0, minor: 0, patch: 0, prerelease: [], given: 0 };
  if (minor === undefined) return { major, minor: 0, patch: 0, prerelease: [], given: 1 };
  if (patch === undefined) return { major, minor, patch: 0, prerelease: [], given: 2 };
  return { major, minor, patch, prerelease: match[4] === undefined ? [] : match[4].split('.'), given: 3 };
}

const text = (major, minor, patch, prerelease = []) =>
  String(major) + '.' + String(minor) + '.' + String(patch) + (prerelease.length === 0 ? '' : '-' + prerelease.join('.'));

function upperForCaret(partial) {
  if (partial.major > 0 || partial.given === 1) return text(partial.major + 1, 0, 0);
  if (partial.minor > 0 || partial.given === 2) return text(0, partial.minor + 1, 0);
  return text(0, 0, partial.patch + 1);
}

function upperForTilde(partial) {
  if (partial.given === 1) return text(partial.major + 1, 0, 0);
  return text(partial.major, partial.minor + 1, 0);
}

/** Expand one comparator into primitive {op, version} comparisons. */
function expand(operator, partial) {
  const lower = text(partial.major, partial.minor, partial.patch, partial.prerelease);
  switch (operator) {
    case '^':
      return [{ op: '>=', version: lower }, { op: '<', version: upperForCaret(partial) }];
    case '~':
    case '~>':
      return [{ op: '>=', version: lower }, { op: '<', version: upperForTilde(partial) }];
    case '>':
      if (partial.given === 3) return [{ op: '>', version: lower }];
      return [{ op: '>=', version: partial.given === 1 ? text(partial.major + 1, 0, 0) : text(partial.major, partial.minor + 1, 0) }];
    case '>=':
      return [{ op: '>=', version: lower }];
    case '<':
      return [{ op: '<', version: lower }];
    case '<=':
      if (partial.given === 3) return [{ op: '<=', version: lower }];
      return [{ op: '<', version: partial.given === 1 ? text(partial.major + 1, 0, 0) : text(partial.major, partial.minor + 1, 0) }];
    default:
      if (partial.given === 3) return [{ op: '=', version: lower }];
      if (partial.given === 1) return [{ op: '>=', version: lower }, { op: '<', version: text(partial.major + 1, 0, 0) }];
      return [{ op: '>=', version: lower }, { op: '<', version: text(partial.major, partial.minor + 1, 0) }];
  }
}

function comparatorSet(source) {
  const trimmed = source.trim();
  if (trimmed === '' || trimmed === '*' || trimmed === 'x' || trimmed === 'X' || trimmed === 'latest') {
    return [{ op: '>=', version: '0.0.0' }];
  }
  const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(trimmed);
  if (hyphen !== null) {
    const from = partialOf(hyphen[1]);
    const to = partialOf(hyphen[2]);
    if (from === null || to === null) return null;
    return [...expand('>=', from), ...(to.given === 3 ? [{ op: '<=', version: text(to.major, to.minor, to.patch, to.prerelease) }] : expand('<=', to))];
  }
  const parts = trimmed.split(/\s+/).filter((part) => part !== '');
  const comparisons = [];
  for (const part of parts) {
    const match = OPERATOR.exec(part);
    if (match === null) return null;
    const operator = match[1] === undefined ? '' : match[1];
    const body = match[2].trim();
    if (body === '' || body === '*' || body === 'x' || body === 'X') {
      comparisons.push({ op: '>=', version: '0.0.0' });
      continue;
    }
    const partial = partialOf(body);
    if (partial === null) return null;
    comparisons.push(...expand(operator, partial));
  }
  return comparisons;
}

const cache = new Map();

function setsOf(range) {
  const key = String(range ?? '*');
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const sets = String(key).split('||').map((part) => comparatorSet(part));
  const resolved = sets.some((set) => set === null) ? null : sets;
  if (cache.size < 4096) cache.set(key, resolved);
  return resolved;
}

function testOne(version, comparison) {
  const order = compareVersions(version, comparison.version);
  switch (comparison.op) {
    case '=': return order === 0;
    case '>': return order > 0;
    case '>=': return order >= 0;
    case '<': return order < 0;
    case '<=': return order <= 0;
    default: return false;
  }
}

/** Whether a version satisfies an npm range. Unparseable input never satisfies. */
export function satisfies(version, range) {
  const parsed = typeof version === 'string' ? parseVersion(version) : version;
  if (parsed === null) return false;
  const sets = setsOf(range);
  if (sets === null) return false;
  const prerelease = parsed.prerelease ?? [];
  for (const set of sets) {
    if (!set.every((comparison) => testOne(parsed, comparison))) continue;
    if (prerelease.length === 0) return true;
    // A prerelease only matches when the range itself names one for the same tuple.
    const allowed = set.some((comparison) => {
      const named = parseVersion(comparison.version);
      if (named === null) return false;
      return named.prerelease.length > 0 && named.major === parsed.major && named.minor === parsed.minor && named.patch === parsed.patch;
    });
    if (allowed) return true;
  }
  return false;
}

/** The highest version in the list that satisfies the range, or null. */
export function maxSatisfying(versions, range) {
  let best = null;
  for (const version of versions) {
    const parsed = parseVersion(version);
    if (parsed === null) continue;
    if (!satisfies(parsed, range)) continue;
    if (best === null || compareVersions(parsed, best) > 0) best = parsed;
  }
  return best === null ? null : text(best.major, best.minor, best.patch, best.prerelease);
}

/** Whether the range names anything a registry can resolve (used for "latest"). */
export function isRange(text) {
  return setsOf(text) !== null;
}
