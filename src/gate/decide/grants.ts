// SPDX-License-Identifier: AGPL-3.0-only
// Grants: what a person allowed. A grants value is built only from command-line flags, or from the already-parsed
// content of a file a person wrote. This module reads no file and no environment, and nothing here reads a plan, a
// page or a model's answer. A plan file never allows a host (threat model, A4): the caller of `grantsFromFile` must
// hand it a grants file a person wrote, never a plan.

export interface Grants {
  /** `--active`: send probes the interface wouldn't send. */
  readonly active: boolean;
  /** `--allow-writes`: send requests that change state or spend money. */
  readonly allowWrites: boolean;
  /** `--allow-disrupt`: break or degrade on purpose. */
  readonly allowDisrupt: boolean;
  /** `--allow-exec`: run the target's own code outside a container. */
  readonly allowExec: boolean;
  /** `--allow-host`: hosts a person names as theirs. Not enough by itself: the owner's token must be found too. */
  readonly allowHosts: readonly string[];
}

export class GrantsError extends Error {}

// Every Grants value one of the builders made. `decide` honours no other, so a plain object built by hand, or a
// copy of an issued one, grants nothing.
const issued = new WeakSet<object>();

function issue(g: Grants): Grants {
  const frozen = Object.freeze({ ...g, allowHosts: Object.freeze([...g.allowHosts]) });
  issued.add(frozen);
  return frozen;
}

export function isIssuedGrants(value: unknown): value is Grants {
  return typeof value === 'object' && value !== null && issued.has(value);
}

/** No grant at all. */
export function noGrants(): Grants {
  return issue({ active: false, allowWrites: false, allowDisrupt: false, allowExec: false, allowHosts: [] });
}

const HOST = /^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$/;

function parseHost(value: unknown): string {
  const host = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!HOST.test(host)) throw new GrantsError(`not a bare host name: ${JSON.stringify(value)}`);
  return host;
}

const BOOLEAN_FLAGS = {
  '--active': 'active',
  '--allow-writes': 'allowWrites',
  '--allow-disrupt': 'allowDisrupt',
  '--allow-exec': 'allowExec',
} as const;

/** Build grants from the command line. Flags that aren't grants are ignored; an `--allow-*` flag it doesn't know is an error. */
export function grantsFromFlags(argv: readonly string[]): Grants {
  const g = { active: false, allowWrites: false, allowDisrupt: false, allowExec: false, allowHosts: [] as string[] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (Object.hasOwn(BOOLEAN_FLAGS, arg)) {
      g[BOOLEAN_FLAGS[arg as keyof typeof BOOLEAN_FLAGS]] = true;
    } else if (arg === '--allow-host') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new GrantsError('--allow-host needs a host name');
      g.allowHosts.push(parseHost(value));
      i++;
    } else if (arg.startsWith('--allow-host=')) {
      g.allowHosts.push(parseHost(arg.slice('--allow-host='.length)));
    } else if (arg.startsWith('--allow-')) {
      throw new GrantsError(`unknown grant flag: ${arg}`);
    }
  }
  return issue(g);
}

const FILE_KEYS = ['active', 'allowWrites', 'allowDisrupt', 'allowExec', 'allowHosts'];

/** Build grants from the already-parsed content of a file a person wrote. Unknown keys and wrong types are errors. */
export function grantsFromFile(parsed: unknown): Grants {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new GrantsError('a grants file holds one object');
  }
  const record = parsed as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!FILE_KEYS.includes(key)) throw new GrantsError(`unknown key in a grants file: ${key}`);
  }
  const flag = (key: string): boolean => {
    const v = record[key];
    if (v === undefined) return false;
    if (typeof v !== 'boolean') throw new GrantsError(`${key} must be true or false`);
    return v;
  };
  const hosts = record.allowHosts;
  if (hosts !== undefined && !Array.isArray(hosts)) throw new GrantsError('allowHosts must be a list of host names');
  return issue({
    active: flag('active'),
    allowWrites: flag('allowWrites'),
    allowDisrupt: flag('allowDisrupt'),
    allowExec: flag('allowExec'),
    allowHosts: (hosts ?? []).map(parseHost),
  });
}
