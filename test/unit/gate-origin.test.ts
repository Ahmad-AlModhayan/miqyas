// SPDX-License-Identifier: AGPL-3.0-only
// Classing an origin (ALGORITHMS B2): one test per class, and the sandbox-wins case.

import { describe, expect, it } from 'vitest';
import { classOfOrigin, grantsFromFlags, noGrants, type OriginFacts } from '../../src/gate/decide/index.js';

const run = (over: Partial<OriginFacts> = {}): OriginFacts => ({
  targets: [],
  engineStarted: [],
  ownershipTokenHosts: [],
  observedCalls: [],
  ...over,
});

const envOf = (origin: string, facts: OriginFacts = run(), grants = noGrants()) =>
  classOfOrigin(origin, facts, grants).environment;

describe('a sandbox', () => {
  const started = (onlyRouteOutIsGate: boolean) =>
    run({ targets: ['http://127.0.0.1:4100'], engineStarted: [{ origin: 'http://127.0.0.1:4100', onlyRouteOutIsGate }] });

  it('is an origin whose process the engine started in this run and whose only way out is the gate', () => {
    expect(classOfOrigin('http://127.0.0.1:4100', started(true), noGrants())).toMatchObject({
      environment: 'sandbox',
      rule: 'origin.sandbox',
    });
  });

  it('is not one when the process can reach the network some other way', () => {
    expect(envOf('http://127.0.0.1:4100', started(false))).toBe('local-test-host');
  });

  it('is not one when the engine did not start the process, even if the person named it', () => {
    expect(envOf('http://127.0.0.1:4100', run({ targets: ['http://127.0.0.1:4100'] }))).toBe('local-test-host');
  });

  it('is judged by origin, so another port of the same host is not one', () => {
    expect(envOf('http://127.0.0.1:4101', started(true))).toBe('local-test-host');
  });

  it('wins over a test host by name: an origin that is both is a sandbox', () => {
    for (const origin of ['http://localhost:4100', 'http://shop.test', 'https://staging.example.com', 'http://app.localhost:3000']) {
      const facts = run({ targets: [origin], engineStarted: [{ origin, onlyRouteOutIsGate: true }] });
      expect(envOf(origin, facts)).toBe('sandbox');
    }
  });

  it('wins over an owned host: the engine started it, so it is a sandbox whatever the token says', () => {
    const origin = 'https://staging.example.com';
    const facts = run({
      targets: [origin],
      engineStarted: [{ origin, onlyRouteOutIsGate: true }],
      ownershipTokenHosts: ['staging.example.com'],
    });
    expect(envOf(origin, facts, grantsFromFlags(['--allow-host', 'staging.example.com']))).toBe('sandbox');
  });
});

describe('a local test host', () => {
  it.each([
    'http://127.0.0.1:3000',
    'http://127.4.5.6',
    'http://localhost:5173',
    'http://[::1]:8080',
    'http://app.localhost:3000',
    'http://shop.test',
    'https://deep.shop.test:8443',
  ])('is a loopback, .localhost or .test URL given on the command line: %s', (url) => {
    expect(classOfOrigin(url, run({ targets: [url] }), noGrants())).toMatchObject({
      environment: 'local-test-host',
      rule: 'origin.local-test-host',
    });
  });

  it.each([
    'http://localhost.evil.example',
    'http://127.0.0.1.evil.example',
    'http://evil-localhost.example',
    'http://notlocalhost',
    'http://test',
    'http://0.0.0.0:3000',
    'http://10.0.0.5:3000',
    'http://192.168.1.5',
    'http://169.254.169.254',
    'http://[::ffff:7f00:1]',
    'http://printer.local',
    'http://wiki.internal',
  ])('is not a name that only looks like one, or an address the docs do not list: %s', (url) => {
    expect(envOf(url, run({ targets: [url] }))).toBe('other');
  });
});

describe('a named test host', () => {
  it.each([
    'https://staging.example.com',
    'https://dev.example.com',
    'https://qa.example.com',
    'https://test.example.com',
    'https://app.staging.example.com:8443',
    'https://dev.example.co.uk',
  ])('is a public name that carries a test label: %s', (url) => {
    expect(classOfOrigin(url, run({ targets: [url] }), noGrants())).toMatchObject({
      environment: 'named-test-host',
      rule: 'origin.named-test-host',
    });
  });

  it.each([
    'https://example.dev', // a top-level domain is not a label of the name
    'https://dev.to', // nor is the registered name itself
    'https://test.com',
    'https://api-staging.example.com', // a label is whole
    'https://stagingarea.example.com',
    'https://example.com',
  ])('is not a name that only contains the letters: %s', (url) => {
    expect(envOf(url, run({ targets: [url] }))).toBe('other');
  });
});

// The classing works on one canonical form of a host: lower case, with exactly one trailing dot removed. A host that
// still has an empty label after that is not in the form and never gains a class.
describe('a host that is not in canonical form', () => {
  it('is not a named test host when the dot at the end shifts the registered name into the checked labels', () => {
    for (const url of ['https://test.com.', 'https://staging.com.', 'https://dev.to.']) {
      expect(envOf(url, run({ targets: [url] }))).toBe('other');
    }
  });

  it('is not a named or local test host when a label is empty', () => {
    for (const url of ['https://staging..example.com', 'https://.staging.example.com', 'https://staging.example.com..', 'http://localhost..', 'http://x..test', 'http://a..localhost']) {
      expect(envOf(url, run({ targets: [url] }))).toBe('other');
    }
  });

  it('gets the class of the same name without its one trailing dot', () => {
    expect(envOf('https://staging.example.com.')).toBe('named-test-host');
    expect(envOf('https://staging.example.com')).toBe('named-test-host');
    expect(envOf('http://x.test.')).toBe('local-test-host');
    expect(envOf('http://x.test')).toBe('local-test-host');
  });

  it('counts localhost. as localhost: the one rule strips a single trailing dot', () => {
    expect(envOf('http://localhost.:3000')).toBe('local-test-host');
    expect(envOf('http://127.0.0.1.:3000')).toBe('local-test-host');
  });

  it('is the same class in upper case, and an IPv6 literal in brackets is judged as a literal', () => {
    expect(envOf('HTTPS://STAGING.Example.COM')).toBe('named-test-host');
    expect(envOf('http://[::1]:3000')).toBe('local-test-host');
    expect(envOf('http://[2001:db8::1]:3000')).toBe('other');
  });

  it('names the same host with and without the trailing dot for --allow-host and the token', () => {
    const url = 'https://shop.example.com.';
    const facts = run({ targets: [url], ownershipTokenHosts: ['shop.example.com'] });
    expect(envOf(url, facts, grantsFromFlags(['--allow-host', 'shop.example.com']))).toBe('owned-host');
  });

  it('is the same origin as the name without the dot, so a sandbox started on one is a sandbox on the other', () => {
    const facts = run({ targets: ['http://localhost:4100'], engineStarted: [{ origin: 'http://localhost:4100', onlyRouteOutIsGate: true }] });
    expect(envOf('http://localhost.:4100/x', facts)).toBe('sandbox');
  });
});

describe('an owned host', () => {
  const url = 'https://shop.example.com';

  it('is named with --allow-host and has its owner’s token found', () => {
    const facts = run({ targets: [url], ownershipTokenHosts: ['shop.example.com'] });
    expect(classOfOrigin(url, facts, grantsFromFlags(['--allow-host', 'shop.example.com']))).toMatchObject({
      environment: 'owned-host',
      rule: 'origin.owned-host',
    });
  });

  it('needs the token: --allow-host alone leaves it other', () => {
    expect(envOf(url, run({ targets: [url] }), grantsFromFlags(['--allow-host', 'shop.example.com']))).toBe('other');
  });

  it('needs --allow-host: a token found for a host nobody named leaves it other', () => {
    expect(envOf(url, run({ targets: [url], ownershipTokenHosts: ['shop.example.com'] }))).toBe('other');
  });

  it('is judged by the host named, not by a host that merely contains it', () => {
    const facts = run({ targets: ['https://shop.example.com.evil.example'], ownershipTokenHosts: ['shop.example.com'] });
    expect(envOf('https://shop.example.com.evil.example', facts, grantsFromFlags(['--allow-host', 'shop.example.com']))).toBe(
      'other',
    );
  });

  it('is an owned host even when its name is also a test label, because the token was found', () => {
    const named = 'https://staging.example.com';
    const facts = run({ targets: [named], ownershipTokenHosts: ['staging.example.com'] });
    expect(envOf(named, facts, grantsFromFlags(['--allow-host', 'staging.example.com']))).toBe('owned-host');
  });

  it('is not made by a grants value a caller wrote by hand', () => {
    const forged = { active: true, allowWrites: true, allowDisrupt: true, allowExec: true, allowHosts: ['shop.example.com'] };
    expect(envOf(url, run({ targets: [url], ownershipTokenHosts: ['shop.example.com'] }), forged)).toBe('other');
  });
});

describe('a backend', () => {
  const target = 'http://localhost:3000';
  const api = 'https://abcd.supabase.example';

  it('is an origin a page of an origin of this run was observed calling, and takes its consent from that origin', () => {
    const c = classOfOrigin(api, run({ targets: [target], observedCalls: [{ from: target, to: api }] }), noGrants());
    expect(c).toMatchObject({ environment: 'backend', rule: 'origin.backend' });
    expect(c.callers.map((x) => [x.origin, x.environment])).toEqual([[target, 'local-test-host']]);
  });

  it('keeps every origin that calls it, so the most restrictive of them can decide', () => {
    const other = 'https://shop.example';
    const facts = run({
      targets: [target, other],
      observedCalls: [
        { from: target, to: api },
        { from: other, to: api },
      ],
    });
    expect(classOfOrigin(api, facts, noGrants()).callers.map((x) => x.environment)).toEqual(['local-test-host', 'other']);
  });

  it('is not one when the page that called it is not an origin of this run', () => {
    expect(envOf(api, run({ targets: [target], observedCalls: [{ from: 'https://stranger.example', to: api }] }))).toBe('other');
  });

  it('is a sandbox only if the engine started it too', () => {
    const facts = run({
      targets: [target],
      engineStarted: [{ origin: api, onlyRouteOutIsGate: true }],
      observedCalls: [{ from: target, to: api }],
    });
    expect(envOf(api, facts)).toBe('sandbox');
  });

  it('is judged by its own name first: a backend that is a local test host by name is one', () => {
    const local = 'http://127.0.0.1:9000';
    expect(envOf(local, run({ targets: [target], observedCalls: [{ from: target, to: local }] }))).toBe('local-test-host');
  });

  it('does not recurse when two origins of the run call each other', () => {
    const a = 'https://a.example';
    const b = 'https://b.example';
    const facts = run({
      targets: [a, b],
      observedCalls: [
        { from: a, to: b },
        { from: b, to: a },
      ],
    });
    expect(classOfOrigin(b, facts, noGrants()).callers.map((x) => x.environment)).toEqual(['other']);
  });
});

describe('any other origin', () => {
  it('is everything else', () => {
    expect(classOfOrigin('https://shop.example', run({ targets: ['https://shop.example'] }), noGrants())).toMatchObject({
      environment: 'other',
      rule: 'origin.other',
    });
  });

  it('includes a name that cannot be parsed, and a scheme that is not a web one', () => {
    for (const odd of ['', 'not a url', 'file:///etc/passwd', 'ftp://localhost/x', 'data:text/plain,hi']) {
      expect(classOfOrigin(odd, run({ targets: [odd] }), noGrants()).environment).toBe('other');
    }
  });

  it('takes the origin of a full URL, with its scheme, host and port compared exactly', () => {
    const facts = run({ targets: ['http://127.0.0.1:4100'], engineStarted: [{ origin: 'http://127.0.0.1:4100', onlyRouteOutIsGate: true }] });
    expect(envOf('HTTP://127.0.0.1:4100/some/path?x=1#y', facts)).toBe('sandbox');
    expect(envOf('https://127.0.0.1:4100/', facts)).toBe('local-test-host');
  });
});
