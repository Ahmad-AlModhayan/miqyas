// SPDX-License-Identifier: AGPL-3.0-only
// Classing a request at the wire (docs/ALGORITHMS.md B1). The class is worked out from the request, never taken from
// the caller: a caller may declare a higher class and never a lower one. Pure.

import { atLeast, maxEffect, type EffectClass } from './classes.js';
import { originOf } from './origin.js';

/** A request, as the gate sees it on the wire. */
export interface WireRequest {
  readonly method: string;
  readonly url: string;
  /** `page`: the target's own page sent it. `collector`: a collector sent it itself. Anything else counts as a collector. */
  readonly cause: 'page' | 'collector';
  /** The class a caller says the request is. It can raise the class found and never lower it. */
  readonly declared?: EffectClass;
  readonly body?: string;
  readonly contentType?: string;
}

/** What the engine has recorded about routes. A route is a URL without its query; `:name` stands for any one path segment. */
export interface RouteFacts {
  /** Routes recorded as spending money. */
  readonly spendingRoutes: readonly string[];
  /** Routes whose footprint (ALGORITHMS M4) was seen not to be empty, in this run or in the target model. Only ever added to. */
  readonly seenToChange: readonly string[];
  /** Endpoints a probe's definition lists as reads: `METHOD route`. */
  readonly knownReads: readonly string[];
}

export interface WireClass {
  readonly effectClass: EffectClass;
  /** The B1 rules that set or raised the class, in order: `wire.<rule>`. */
  readonly reasons: readonly string[];
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function segmentsOf(url: string, foldCase: boolean): { origin: string; segments: string[] } | null {
  const origin = originOf(url);
  if (origin === null) return null;
  const pathname = new URL(url).pathname;
  const segments = pathname
    .split('/')
    .filter((s) => s !== '')
    .map((s) => {
      let d = s;
      try {
        d = decodeURIComponent(s);
      } catch {
        // keep the raw segment
      }
      return foldCase ? d.toLowerCase() : d;
    });
  return { origin, segments };
}

function routeMatches(pattern: string, url: string, foldCase: boolean): boolean {
  const p = segmentsOf(pattern, foldCase);
  const r = segmentsOf(url, foldCase);
  if (p === null || r === null || p.origin !== r.origin || p.segments.length !== r.segments.length) return false;
  return p.segments.every((seg, i) => seg.startsWith(':') || seg === r.segments[i]);
}

// A GraphQL document is a known read only if every operation in it is a query. The scan reads names and brackets
// and nothing else, and anything it cannot make sense of is not a read.
function allOperationsAreQueries(doc: string): boolean {
  let depth = 0;
  let pendingHeader = false;
  let operations = 0;
  let i = 0;
  while (i < doc.length) {
    const ch = doc[i] as string;
    if (ch === '#') {
      while (i < doc.length && doc[i] !== '\n' && doc[i] !== '\r') i++;
    } else if (doc.startsWith('"""', i)) {
      const end = doc.indexOf('"""', i + 3);
      if (end === -1) return false;
      i = end + 3;
    } else if (ch === '"') {
      i++;
      while (i < doc.length && doc[i] !== '"') i += doc[i] === '\\' ? 2 : 1;
      if (i >= doc.length) return false;
      i++;
    } else if (ch === '{' || ch === '(' || ch === '[') {
      if (depth === 0 && ch === '{') {
        // A selection set that no header introduced is the shorthand for an anonymous query.
        if (!pendingHeader) operations++;
        pendingHeader = false;
      }
      depth++;
      i++;
    } else if (ch === '}' || ch === ')' || ch === ']') {
      depth--;
      if (depth < 0) return false;
      i++;
    } else if (/[A-Za-z_]/.test(ch)) {
      let j = i + 1;
      while (j < doc.length && /[A-Za-z0-9_]/.test(doc[j] as string)) j++;
      const name = doc.slice(i, j);
      if (depth === 0) {
        if (name === 'query') {
          operations++;
          pendingHeader = true;
        } else if (name === 'mutation' || name === 'subscription') {
          return false;
        } else if (name === 'fragment') {
          pendingHeader = true;
        } else if (!pendingHeader) {
          return false; // a definition that is not an operation or a fragment
        }
      }
      i = j;
    } else {
      i++;
    }
  }
  return depth === 0 && operations > 0 && !pendingHeader;
}

// The read is judged by the document, and only in a request that is GraphQL over HTTP: a POST (GET is a safe method
// already, and no other method carries an operation) of a JSON object with a string `query`. A batch, a stored
// query that has no `query`, a raw body and a body with no JSON content type are not known reads.
function isGraphqlQuery(req: WireRequest): boolean {
  if (typeof req.method !== 'string' || req.method.toUpperCase() !== 'POST') return false;
  if (typeof req.contentType !== 'string' || !/^application\/json\s*(;|$)/i.test(req.contentType.trim())) return false;
  const body = req.body;
  if (typeof body !== 'string') return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return false;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return false;
  const query = (parsed as { query?: unknown }).query;
  return typeof query === 'string' && allOperationsAreQueries(query);
}

function isKnownRead(req: WireRequest, routes: RouteFacts): boolean {
  if (isGraphqlQuery(req)) return true;
  const method = String(req.method).toUpperCase();
  return routes.knownReads.some((entry) => {
    const space = entry.indexOf(' ');
    return space > 0 && entry.slice(0, space).toUpperCase() === method && routeMatches(entry.slice(space + 1), req.url, false);
  });
}

/**
 * Class a request (B1). `session.permit` is the permit the collector holds. Under an interact permit what a page
 * sends is interact; under any other permit it is observe; what a collector sends itself is a probe. A method that
 * is not safe makes a write unless the request is a known read; a spending route and a route seen to change state
 * make a write. A caller's declared class can only raise the result.
 */
export function classOfRequest(req: WireRequest, session: { readonly permit: EffectClass }, routes: RouteFacts): WireClass {
  let c: EffectClass;
  const reasons: string[] = [];
  if (req.cause === 'page' && session.permit === 'interact') {
    c = 'interact';
    reasons.push('wire.page-interact');
  } else if (req.cause === 'page') {
    c = 'observe';
    reasons.push('wire.page-observe');
  } else {
    c = 'probe';
    reasons.push('wire.collector-probe');
  }
  const raise = (to: EffectClass, reason: string) => {
    reasons.push(reason);
    c = maxEffect(c, to);
  };

  const readable = originOf(req.url) !== null;
  if (!readable) {
    // Nothing can be known about a URL that cannot be read, so it is treated as a write.
    raise('write', 'wire.unreadable-url');
  } else {
    const safe = typeof req.method === 'string' && SAFE_METHODS.has(req.method.toUpperCase());
    if (!safe) {
      if (isKnownRead(req, routes)) reasons.push('wire.known-read');
      else raise('write', 'wire.unsafe-method');
    }
    if (routes.spendingRoutes.some((r) => routeMatches(r, req.url, true))) raise('write', 'wire.spending-route');
    if (routes.seenToChange.some((r) => routeMatches(r, req.url, true))) raise('write', 'wire.seen-to-change');
  }
  if (req.declared !== undefined && !atLeast(c, req.declared)) {
    raise(req.declared, 'wire.declared');
  }
  return { effectClass: c, reasons };
}
