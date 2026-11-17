// SPDX-License-Identifier: AGPL-3.0-only
// Classing a request at the wire (ALGORITHMS B1): one test per rule.

import { describe, expect, it } from 'vitest';
import { classOfRequest, type RouteFacts, type WireRequest } from '../../src/gate/decide/index.js';

const noRoutes: RouteFacts = { spendingRoutes: [], seenToChange: [], knownReads: [] };
const routes = (over: Partial<RouteFacts>): RouteFacts => ({ ...noRoutes, ...over });

const page = (method: string, url = 'https://app.test/items', extra: Partial<WireRequest> = {}): WireRequest => ({
  method,
  url,
  cause: 'page',
  ...extra,
});
const collector = (method: string, url = 'https://app.test/items', extra: Partial<WireRequest> = {}): WireRequest => ({
  method,
  url,
  cause: 'collector',
  ...extra,
});
const gql = (doc: unknown, extra: Partial<WireRequest> = {}): WireRequest => ({
  method: 'POST',
  url: 'https://app.test/graphql',
  cause: 'collector',
  body: typeof doc === 'string' ? doc : JSON.stringify(doc),
  contentType: 'application/json',
  ...extra,
});

describe('what a page sends', () => {
  it('is interact under an interact permit, because of a plan step', () => {
    expect(classOfRequest(page('GET'), { permit: 'interact' }, noRoutes)).toEqual({
      effectClass: 'interact',
      reasons: ['wire.page-interact'],
    });
  });

  it('is observe under an observe permit, during a crawl', () => {
    expect(classOfRequest(page('GET'), { permit: 'observe' }, noRoutes)).toEqual({
      effectClass: 'observe',
      reasons: ['wire.page-observe'],
    });
  });

  it('is observe under any permit that is not interact, so a higher permit does not make a page request more', () => {
    for (const permit of ['probe', 'write', 'disrupt'] as const) {
      expect(classOfRequest(page('GET'), { permit }, noRoutes).effectClass).toBe('observe');
    }
  });

  it('is sent by a collector itself at least as a probe, when no page sent it', () => {
    expect(classOfRequest(collector('GET'), { permit: 'probe' }, noRoutes)).toEqual({
      effectClass: 'probe',
      reasons: ['wire.collector-probe'],
    });
  });

  it('is judged from the request, so a collector under an interact permit is still a probe', () => {
    expect(classOfRequest(collector('GET'), { permit: 'interact' }, noRoutes).effectClass).toBe('probe');
  });

  it('is a probe when the cause is anything the gate does not know', () => {
    expect(classOfRequest({ ...page('GET'), cause: 'agent' as never }, { permit: 'interact' }, noRoutes).effectClass).toBe('probe');
  });
});

describe('a method that is not safe', () => {
  it.each(['POST', 'PUT', 'PATCH', 'DELETE', 'post', 'PURGE', 'TRACE', 'CONNECT', ''])('makes %j at least a write', (method) => {
    const c = classOfRequest(collector(method), { permit: 'probe' }, noRoutes);
    expect(c.effectClass).toBe('write');
    expect(c.reasons).toContain('wire.unsafe-method');
  });

  it.each(['GET', 'HEAD', 'OPTIONS', 'get', 'Head'])('leaves %j as it was', (method) => {
    expect(classOfRequest(collector(method), { permit: 'probe' }, noRoutes).effectClass).toBe('probe');
  });

  it('makes a method that is not even a string a write', () => {
    expect(classOfRequest({ ...collector('GET'), method: undefined as never }, { permit: 'probe' }, noRoutes).effectClass).toBe('write');
  });

  it('makes a write of what a page sends too, under an observe permit as under an interact permit', () => {
    expect(classOfRequest(page('POST'), { permit: 'observe' }, noRoutes).effectClass).toBe('write');
    expect(classOfRequest(page('DELETE'), { permit: 'interact' }, noRoutes).effectClass).toBe('write');
  });

  it('makes a write of a URL that cannot be read, because nothing can be known about it', () => {
    const c = classOfRequest(collector('GET', 'not a url'), { permit: 'probe' }, noRoutes);
    expect(c.effectClass).toBe('write');
    expect(c.reasons).toContain('wire.unreadable-url');
  });
});

describe('a known read', () => {
  it('is a GraphQL document whose every operation is a query: it is not made a write by its method', () => {
    const queries = [
      { query: 'query Me { me { id name } }' },
      { query: '{ me { id } }' },
      { query: 'query A { a } query B { b }', operationName: 'A' },
      { query: 'query Q($input: In = {a: 1}) { items(input: $input) { id } } fragment F on Item { id }' },
      [{ query: '{ a }' }, { query: '{ b }' }],
      { query: '# mutation in a comment\n query { a(arg: "mutation { x }") }' },
      { query: 'query { a(arg: """mutation { x }""") }' },
    ];
    for (const doc of queries) {
      expect(classOfRequest(gql(doc), { permit: 'probe' }, noRoutes)).toEqual({
        effectClass: 'probe',
        reasons: ['wire.collector-probe', 'wire.known-read'],
      });
    }
  });

  it('is also a raw application/graphql body', () => {
    expect(classOfRequest(gql('{ me { id } }', { contentType: 'application/graphql' }), { permit: 'probe' }, noRoutes).effectClass).toBe('probe');
  });

  it('is not a mutation, a subscription, or a document that mixes a query with one', () => {
    const notReads = [
      { query: 'mutation { deleteAll }' },
      { query: 'mutation Delete($id: ID!) { delete(id: $id) }' },
      { query: 'subscription { changed }' },
      { query: 'query A { a } mutation B { b }' },
      [{ query: '{ a }' }, { query: 'mutation { b }' }],
    ];
    for (const doc of notReads) {
      expect(classOfRequest(gql(doc), { permit: 'probe' }, noRoutes).effectClass).toBe('write');
    }
  });

  it('is not a document it cannot read, a request with no query in it, or one that only names a stored query', () => {
    const unknown = [
      '',
      'not json at all',
      { query: '{ a ' },
      { query: '{ a } }' },
      { query: 'type T { a: Int }' },
      { query: '' },
      { extensions: { persistedQuery: { sha256Hash: 'abc' } } },
      { query: 42 },
      [{ query: '{ a }' }, 'x'],
      [],
    ];
    for (const doc of unknown) {
      expect(classOfRequest(gql(doc), { permit: 'probe' }, noRoutes).effectClass).toBe('write');
    }
    expect(classOfRequest(gql('{ me { id } }', { contentType: 'text/plain' }), { permit: 'probe' }, noRoutes).effectClass).toBe('write');
    expect(classOfRequest({ ...gql('x'), body: undefined }, { permit: 'probe' }, noRoutes).effectClass).toBe('write');
  });

  it('is an endpoint a probe’s definition lists as a read, by method and route', () => {
    const facts = routes({ knownReads: ['POST https://app.test/rpc/search', 'POST https://app.test/rpc/items/:id'] });
    expect(classOfRequest(collector('POST', 'https://app.test/rpc/search?q=1'), { permit: 'probe' }, facts)).toEqual({
      effectClass: 'probe',
      reasons: ['wire.collector-probe', 'wire.known-read'],
    });
    expect(classOfRequest(collector('POST', 'https://app.test/rpc/items/7'), { permit: 'probe' }, facts).effectClass).toBe('probe');
  });

  it('is not an endpoint listed for another method, another route or another origin', () => {
    const facts = routes({ knownReads: ['POST https://app.test/rpc/search'] });
    for (const r of [
      collector('PUT', 'https://app.test/rpc/search'),
      collector('POST', 'https://app.test/rpc/search/extra'),
      collector('POST', 'https://app.test/rpc/other'),
      collector('POST', 'https://evil.test/rpc/search'),
    ]) {
      expect(classOfRequest(r, { permit: 'probe' }, facts).effectClass).toBe('write');
    }
  });
});

describe('a spending route', () => {
  const facts = routes({ spendingRoutes: ['https://app.test/api/send-sms', 'https://app.test/api/chat/:room'] });

  it('makes even a GET a write', () => {
    const c = classOfRequest(collector('GET', 'https://app.test/api/send-sms'), { permit: 'probe' }, facts);
    expect(c.effectClass).toBe('write');
    expect(c.reasons).toContain('wire.spending-route');
  });

  it('is found through a trailing slash, a query, a case difference and a route parameter', () => {
    for (const url of ['https://app.test/api/send-sms/', 'https://app.test/api/send-sms?to=1', 'https://APP.test/API/Send-SMS', 'https://app.test/api/chat/42']) {
      expect(classOfRequest(collector('GET', url), { permit: 'probe' }, facts).effectClass).toBe('write');
    }
  });

  it('is not another route, or the same path on another origin', () => {
    for (const url of ['https://app.test/api/send', 'https://app.test/api/send-sms/x', 'https://other.test/api/send-sms']) {
      expect(classOfRequest(collector('GET', url), { permit: 'probe' }, facts).effectClass).toBe('probe');
    }
  });

  it('is not lifted by a read pattern: a known read stays a write on a spending route', () => {
    const both = routes({ spendingRoutes: ['https://app.test/graphql'] });
    expect(classOfRequest(gql({ query: '{ a }' }), { permit: 'probe' }, both).effectClass).toBe('write');
  });

  it('is a write for a page request as well', () => {
    expect(classOfRequest(page('GET', 'https://app.test/api/send-sms'), { permit: 'observe' }, facts).effectClass).toBe('write');
  });
});

describe('a route seen to change state', () => {
  // The input exists; nothing feeds it yet (ticket 49).
  const facts = routes({ seenToChange: ['https://app.test/items/:id/archive'] });

  it('makes even a GET a write, and a footprint raises a class and never lowers one', () => {
    const c = classOfRequest(collector('GET', 'https://app.test/items/3/archive'), { permit: 'probe' }, facts);
    expect(c.effectClass).toBe('write');
    expect(c.reasons).toContain('wire.seen-to-change');
  });

  it('is not undone by a read pattern', () => {
    const both = routes({ seenToChange: ['https://app.test/graphql'], knownReads: ['POST https://app.test/graphql'] });
    expect(classOfRequest(gql({ query: '{ a }' }), { permit: 'probe' }, both).effectClass).toBe('write');
  });

  it('leaves a route that was not seen to change as it was, whatever else is listed', () => {
    expect(classOfRequest(collector('GET', 'https://app.test/items/3'), { permit: 'probe' }, facts).effectClass).toBe('probe');
  });
});

describe('a declared class', () => {
  it('may be higher than the one found, and then it is the class', () => {
    expect(classOfRequest(collector('GET', 'https://app.test/x', { declared: 'disrupt' }), { permit: 'probe' }, noRoutes)).toEqual({
      effectClass: 'disrupt',
      reasons: ['wire.collector-probe', 'wire.declared'],
    });
  });

  it('is never lower than the one found', () => {
    expect(classOfRequest(collector('POST', 'https://app.test/x', { declared: 'observe' }), { permit: 'probe' }, noRoutes).effectClass).toBe('write');
    expect(classOfRequest(collector('GET', 'https://app.test/x', { declared: 'observe' }), { permit: 'probe' }, noRoutes)).toEqual({
      effectClass: 'probe',
      reasons: ['wire.collector-probe'],
    });
  });

  it('is the most restrictive class when it is one the gate does not know', () => {
    expect(classOfRequest(collector('GET', 'https://app.test/x', { declared: 'root' as never }), { permit: 'probe' }, noRoutes).effectClass).toBe('execute');
  });
});
