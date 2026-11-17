// SPDX-License-Identifier: AGPL-3.0-only
// Classing an origin (docs/ALGORITHMS.md B2). Pure: the facts it needs are handed in, and none of them is read here.

import type { EnvironmentClass } from './classes.js';
import { isIssuedGrants, type Grants } from './grants.js';

/** What the engine knows about the origins of a run. Each field is established by code, never claimed by a plan, a page or a model. */
export interface OriginFacts {
  /** The origins the run is about, as the person named them on the command line or in a file they wrote. */
  readonly targets: readonly string[];
  /** The processes the engine started in this run, and whether the gate is their only way out. */
  readonly engineStarted: readonly { readonly origin: string; readonly onlyRouteOutIsGate: boolean }[];
  /** The hosts at which the owner's ownership token was found. */
  readonly ownershipTokenHosts: readonly string[];
  /** Calls a page of one origin was observed making to another. */
  readonly observedCalls: readonly { readonly from: string; readonly to: string }[];
}

export interface OriginClassification {
  /** The origin as the gate compares it (scheme, host and port), or `''` when the input has none. */
  readonly origin: string;
  readonly host: string;
  readonly environment: EnvironmentClass;
  /** The id of the rule that classed it: `origin.<environment>`. */
  readonly rule: string;
  /** For a backend: how each origin of the run that calls it is classed. Empty otherwise. */
  readonly callers: readonly OriginClassification[];
}

const WEB_SCHEMES = new Set(['http:', 'https:', 'ws:', 'wss:']);

function parse(url: string): URL | null {
  try {
    const u = new URL(url);
    return WEB_SCHEMES.has(u.protocol) && u.hostname !== '' ? u : null;
  } catch {
    return null;
  }
}

/** The origin of a URL as the gate compares it, or null when it has none. `ws:` and `wss:` are the same origin as `http:` and `https:`. */
export function originOf(url: string): string | null {
  const u = parse(url);
  if (u === null) return null;
  const scheme = u.protocol === 'ws:' ? 'http:' : u.protocol === 'wss:' ? 'https:' : u.protocol;
  return `${scheme}//${u.host}`;
}

/** The host name of a URL, lower case, or null when it has none. */
export function hostOf(url: string): string | null {
  return parse(url)?.hostname.toLowerCase() ?? null;
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function isLocalTestName(host: string): boolean {
  if (host === 'localhost' || host === '[::1]') return true;
  if (host.endsWith('.localhost') || host.endsWith('.test')) return true;
  const m = IPV4.exec(host);
  return m !== null && Number(m[1]) === 127 && m.slice(1).every((o) => Number(o) <= 255);
}

// The labels of FOUNDATION §6 and CONTEXT.md. A label is a whole label of the name, never part of one.
const TEST_LABELS = new Set(['staging', 'dev', 'test', 'qa']);

function carriesTestLabel(host: string): boolean {
  if (IPV4.test(host) || host.startsWith('[')) return false;
  const labels = host.split('.');
  // The last label is the top-level domain and the one before it is the registered name: neither marks a host as a test host.
  return labels.slice(0, -2).some((l) => TEST_LABELS.has(l));
}

function classify(
  origin: string,
  facts: OriginFacts,
  allowHosts: readonly string[],
  withBackend: boolean,
): OriginClassification {
  const norm = originOf(origin);
  const make = (environment: EnvironmentClass, rule: string, callers: readonly OriginClassification[] = []) => ({
    origin: norm ?? '',
    host: hostOf(origin) ?? '',
    environment,
    rule,
    callers,
  });
  if (norm === null) return make('other', 'origin.other');
  const host = hostOf(origin) as string;

  if (facts.engineStarted.some((s) => originOf(s.origin) === norm && s.onlyRouteOutIsGate === true)) {
    return make('sandbox', 'origin.sandbox');
  }
  if (allowHosts.includes(host) && facts.ownershipTokenHosts.some((h) => h.toLowerCase() === host)) {
    return make('owned-host', 'origin.owned-host');
  }
  if (isLocalTestName(host)) return make('local-test-host', 'origin.local-test-host');
  if (carriesTestLabel(host)) return make('named-test-host', 'origin.named-test-host');
  if (withBackend) {
    const runOrigins = originsOfTheRun(facts);
    const callers = [
      ...new Set(
        facts.observedCalls
          .filter((c) => originOf(c.to) === norm && runOrigins.has(originOf(c.from) ?? ''))
          .map((c) => originOf(c.from) as string),
      ),
    ];
    if (callers.length > 0) {
      // A caller is classed without the backend rule, so two origins that call each other cannot send the gate in circles.
      return make('backend', 'origin.backend', callers.map((c) => classify(c, facts, allowHosts, false)));
    }
  }
  return make('other', 'origin.other');
}

/** The origins the run is about: the ones the person named and the ones the engine started. */
export function originsOfTheRun(facts: OriginFacts): ReadonlySet<string> {
  const set = new Set<string>();
  for (const o of [...facts.targets, ...facts.engineStarted.map((s) => s.origin)]) {
    const n = originOf(o);
    if (n !== null) set.add(n);
  }
  return set;
}

/**
 * Class an origin (B2), in this order: sandbox, owned host, local test host, named test host, backend, other.
 * A sandbox wins over a test host by name. Grants that no builder issued name no host.
 */
export function classOfOrigin(origin: string, run: OriginFacts, grants: Grants): OriginClassification {
  const allowHosts = isIssuedGrants(grants) ? grants.allowHosts : [];
  return classify(origin, run, allowHosts, true);
}
