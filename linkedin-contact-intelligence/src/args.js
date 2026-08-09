/**
 * Minimal CLI argument parser.
 * Supports: --key value | --key=value | --flag | positional command
 */
export function parseArgs(argv = process.argv.slice(2)) {
  const positional = [];
  const flags = {};

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const body = token.slice(2);
      if (body.includes('=')) {
        const [key, ...rest] = body.split('=');
        flags[key] = rest.join('=');
        continue;
      }
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[body] = next;
        i += 1;
      } else {
        flags[body] = true;
      }
    } else {
      positional.push(token);
    }
  }

  return {
    command: positional[0] || null,
    positional: positional.slice(1),
    flags,
  };
}

export function asBoolean(value, fallback = false) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'boolean') return value;
  if (value === true || value === '') return true;
  const normalized = String(value).toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return fallback;
}

export function asNumber(value, fallback) {
  if (value === undefined || value === null || value === true) return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}
