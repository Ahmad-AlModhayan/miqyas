// SPDX-License-Identifier: AGPL-3.0-only
// Deciding (ALGORITHMS B3): the value returned carries the class found, the rule that decided and the answer.

import { describe, expect, it } from 'vitest';
import { decide, noGrants } from '../../src/gate/decide/index.js';
import { O, everyGrant, grants, pageGet, probeSent, request, world } from '../gate-helpers.js';

describe('the value decide returns', () => {
  it('says the class found, the rule that decided and the answer, for an allowed request', () => {
    expect(decide(probeSent('POST', `${O.sandbox}/items`, 'write'), world(), noGrants())).toEqual({
      answer: 'allow',
      effectClass: 'write',
      rule: 'ceiling.write.sandbox',
      environment: 'sandbox',
      origin: O.sandbox,
      missing: [],
      reasons: ['wire.collector-probe', 'wire.unsafe-method'],
    });
  });

  it('says the same for a refusal by the ceiling, and which grants were missing', () => {
    expect(decide(probeSent('POST', `${O.named}/items`, 'write'), world(), grants('--active'))).toEqual({
      answer: 'refuse',
      effectClass: 'write',
      rule: 'ceiling.write.named-test-host',
      environment: 'named-test-host',
      origin: O.named,
      missing: ['allow-writes', 'token'],
      reasons: ['wire.collector-probe', 'wire.unsafe-method'],
    });
  });

  it('can be recorded as it is: plain data that survives a round trip through JSON', () => {
    const d = decide(probeSent('GET', `${O.local}/x`, 'probe'), world(), grants('--active'));
    expect(JSON.parse(JSON.stringify(d))).toEqual(d);
  });

  it('is the same for the same inputs, and changes none of them', () => {
    const effect = probeSent('GET', `${O.local}/x`, 'probe');
    const w = world();
    const before = JSON.stringify([effect, w]);
    expect(decide(effect, w, grants('--active'))).toEqual(decide(effect, w, grants('--active')));
    expect(JSON.stringify([effect, w])).toBe(before);
  });
});

// The cells of ADR 0008, decided: for each, what is refused without the grants and what is allowed with them.
describe('observe and interact', () => {
  it.each(['sandbox', 'local', 'named', 'owned', 'other', 'backendOfLocal', 'backendOfOther'] as const)(
    'allows a page to be observed on %s with no grant',
    (k) => {
      const d = decide(pageGet(`${O[k]}/`), world(), noGrants());
      expect(d).toMatchObject({ answer: 'allow', effectClass: 'observe' });
      expect(d.rule).toMatch(/^ceiling\.observe\./);
    },
  );

  it.each(['sandbox', 'local', 'named', 'owned', 'other'] as const)('allows what a page sends on %s under an interact permit, with no grant', (k) => {
    expect(decide(pageGet(`${O[k]}/`, 'interact'), world(), noGrants())).toMatchObject({ answer: 'allow', effectClass: 'interact' });
  });

  it('allows interact on a backend only through the page', () => {
    expect(decide(pageGet(`${O.backendOfLocal}/rest`, 'interact'), world(), noGrants())).toMatchObject({
      answer: 'allow',
      rule: 'ceiling.interact.backend',
    });
  });
});

describe('probe', () => {
  it('is allowed in a sandbox with no grant', () => {
    expect(decide(probeSent('GET', `${O.sandbox}/x`, 'probe'), world(), noGrants())).toMatchObject({ answer: 'allow', rule: 'ceiling.probe.sandbox' });
  });

  it.each(['local', 'named', 'owned'] as const)('needs --active on %s, and nothing else', (k) => {
    const e = probeSent('GET', `${O[k]}/x`, 'probe');
    expect(decide(e, world(), grants('--allow-host', 'shop.example.com'))).toMatchObject({ answer: 'refuse', missing: ['active'] });
    expect(decide(e, world(), grants('--active', '--allow-host', 'shop.example.com'))).toMatchObject({ answer: 'allow', effectClass: 'probe' });
  });

  it('takes a backend’s consent from the origin that calls it: --active when a local test host calls it', () => {
    const e = probeSent('GET', `${O.backendOfLocal}/x`, 'probe');
    expect(decide(e, world(), noGrants())).toMatchObject({ answer: 'refuse', rule: 'ceiling.probe.backend', missing: ['active'] });
    expect(decide(e, world(), grants('--active'))).toMatchObject({ answer: 'allow', rule: 'ceiling.probe.backend' });
  });

  it('holds a backend of a sandbox to the terms of a local test host, not to the sandbox’s: it may be production', () => {
    const e = probeSent('GET', `${O.backendOfSandbox}/x`, 'probe');
    expect(decide(e, world(), noGrants())).toMatchObject({ answer: 'refuse', missing: ['active'] });
    expect(decide(e, world(), grants('--active'))).toMatchObject({ answer: 'allow' });
  });

  it('is never allowed on another origin, whatever was granted', () => {
    for (const k of ['other', 'backendOfOther'] as const) {
      expect(decide(probeSent('GET', `${O[k]}/x`, 'probe'), world(), everyGrant())).toMatchObject({ answer: 'refuse', environment: expect.any(String) });
    }
  });
});

describe('write', () => {
  const post = (k: keyof typeof O) => probeSent('POST', `${O[k]}/items`, 'write');

  it('is allowed in a sandbox with no grant', () => {
    expect(decide(post('sandbox'), world(), noGrants())).toMatchObject({ answer: 'allow' });
  });

  it('needs --active on a local test host', () => {
    expect(decide(post('local'), world(), noGrants())).toMatchObject({ answer: 'refuse', missing: ['active'] });
    expect(decide(post('local'), world(), grants('--active'))).toMatchObject({ answer: 'allow', rule: 'ceiling.write.local-test-host' });
  });

  it('needs --active, --allow-writes and the token on a named test host', () => {
    expect(decide(post('named'), world(), grants('--active', '--allow-writes'))).toMatchObject({ answer: 'refuse', missing: ['token'] });
    expect(decide(post('named'), world(), grants('--active', '--allow-writes', '--allow-disrupt', '--allow-exec'))).toMatchObject({ answer: 'refuse', missing: ['token'] });
    const withToken = world({ ownershipTokenHosts: ['shop.example.com', 'staging.example.com'] });
    expect(decide(post('named'), withToken, grants('--active'))).toMatchObject({ answer: 'refuse', missing: ['allow-writes'] });
    expect(decide(post('named'), withToken, grants('--active', '--allow-writes'))).toMatchObject({ answer: 'allow', rule: 'ceiling.write.named-test-host' });
  });

  it('needs --active and --allow-writes on an owned host', () => {
    expect(decide(post('owned'), world(), grants('--active', '--allow-host', 'shop.example.com'))).toMatchObject({ answer: 'refuse', missing: ['allow-writes'] });
    expect(decide(post('owned'), world(), grants('--active', '--allow-writes', '--allow-host', 'shop.example.com'))).toMatchObject({ answer: 'allow', environment: 'owned-host' });
  });

  it('needs the origin that calls a backend to consent, and --allow-writes as well', () => {
    expect(decide(post('backendOfLocal'), world(), grants('--active'))).toMatchObject({ answer: 'refuse', missing: ['allow-writes'] });
    expect(decide(post('backendOfLocal'), world(), grants('--allow-writes'))).toMatchObject({ answer: 'refuse', missing: ['active'] });
    expect(decide(post('backendOfLocal'), world(), grants('--active', '--allow-writes'))).toMatchObject({ answer: 'allow' });
  });

  it('is refused on a backend whose caller is a named test host without the token, even with the flags', () => {
    const w = world({ observedCalls: [{ from: O.named, to: O.backendOfLocal }] });
    expect(decide(post('backendOfLocal'), w, grants('--active', '--allow-writes'))).toMatchObject({ answer: 'refuse', missing: ['token'] });
  });

  it('is refused on a backend with any caller that may not be written to', () => {
    const w = world({ observedCalls: [{ from: O.local, to: O.backendOfLocal }, { from: O.other, to: O.backendOfLocal }] });
    expect(decide(post('backendOfLocal'), w, everyGrant())).toMatchObject({ answer: 'refuse' });
  });

  it('is a write for a GET too when the route spends money, so it needs what a write needs', () => {
    const w = world({ spendingRoutes: [`${O.local}/api/send-sms`] });
    const e = probeSent('GET', `${O.local}/api/send-sms`, 'write');
    expect(decide(e, w, grants('--active'))).toMatchObject({ answer: 'allow', effectClass: 'write' });
    expect(decide(probeSent('GET', `${O.local}/api/send-sms`, 'probe'), w, grants('--active'))).toMatchObject({ answer: 'refuse', rule: 'permit.exceeded' });
  });
});

describe('disrupt', () => {
  const declared = (k: keyof typeof O) => probeSent('GET', `${O[k]}/x`, 'disrupt', {}, { declared: 'disrupt' });

  it('is allowed in a sandbox with no grant', () => {
    expect(decide(declared('sandbox'), world(), noGrants())).toMatchObject({ answer: 'allow', effectClass: 'disrupt', rule: 'ceiling.disrupt.sandbox' });
  });

  it('needs --allow-disrupt on a local test host, and --active does not stand in for it', () => {
    expect(decide(declared('local'), world(), grants('--active', '--allow-writes'))).toMatchObject({ answer: 'refuse', missing: ['allow-disrupt'] });
    expect(decide(declared('local'), world(), grants('--allow-disrupt'))).toMatchObject({ answer: 'allow' });
  });

  it('needs --allow-disrupt and the token on a named test host', () => {
    expect(decide(declared('named'), world(), grants('--allow-disrupt'))).toMatchObject({ answer: 'refuse', missing: ['token'] });
    const withToken = world({ ownershipTokenHosts: ['staging.example.com'] });
    expect(decide(declared('named'), withToken, grants('--allow-disrupt'))).toMatchObject({ answer: 'allow' });
  });

  it('needs --allow-disrupt on an owned host', () => {
    expect(decide(declared('owned'), world(), grants('--allow-host', 'shop.example.com'))).toMatchObject({ answer: 'refuse', missing: ['allow-disrupt'] });
    expect(decide(declared('owned'), world(), grants('--allow-disrupt', '--allow-host', 'shop.example.com'))).toMatchObject({ answer: 'allow' });
  });

  it('refuses --allow-disrupt on a backend and on any other origin', () => {
    expect(decide(declared('backendOfLocal'), world(), everyGrant())).toMatchObject({ answer: 'refuse', rule: 'ceiling.disrupt.backend' });
    expect(decide(declared('other'), world(), everyGrant())).toMatchObject({ answer: 'refuse' });
    expect(decide(declared('backendOfOther'), world(), everyGrant())).toMatchObject({ answer: 'refuse' });
  });
});

describe('the permit', () => {
  it('refuses a request a page sends under an observe permit that comes out as a write, even in a sandbox', () => {
    const e = request({ method: 'POST', url: `${O.sandbox}/delete`, cause: 'page' }, 'observe');
    expect(decide(e, world(), everyGrant())).toMatchObject({ answer: 'refuse', rule: 'permit.exceeded', effectClass: 'write' });
  });

  it('refuses what a collector sends above the permit it holds', () => {
    expect(decide(probeSent('POST', `${O.sandbox}/x`, 'probe'), world(), everyGrant())).toMatchObject({ answer: 'refuse', rule: 'permit.exceeded' });
  });

  it('covers a person using the product: a page’s POST under an interact permit is a write the ceiling still judges', () => {
    const post = (k: keyof typeof O) => request({ method: 'POST', url: `${O[k]}/form`, cause: 'page' }, 'interact');
    expect(decide(post('sandbox'), world(), noGrants())).toMatchObject({ answer: 'allow', effectClass: 'write' });
    expect(decide(post('other'), world(), everyGrant())).toMatchObject({ answer: 'refuse' });
  });
});

describe('the grants a caller hands in', () => {
  it('count only when a builder issued them: a hand-made value grants nothing', () => {
    const forged = { active: true, allowWrites: true, allowDisrupt: true, allowExec: true, allowHosts: ['shop.example.com'] };
    expect(decide(probeSent('GET', `${O.local}/x`, 'probe'), world(), forged as never)).toMatchObject({ answer: 'refuse', missing: ['active'] });
    expect(decide(probeSent('GET', `${O.local}/x`, 'probe'), world(), undefined as never)).toMatchObject({ answer: 'refuse' });
  });
});

describe('executing the target’s own code', () => {
  const run = (contained: object) => ({ kind: 'run-code' as const, source: 'target' as const, containment: contained });
  const container = { startedByEngine: true, noNetwork: true, readOnlyRepository: true };

  it('is allowed in a container the engine started with no network and a read-only copy of the repository', () => {
    expect(decide(run(container), world(), noGrants())).toMatchObject({ answer: 'allow', effectClass: 'execute', rule: 'ceiling.execute.container' });
  });

  it('is refused when any one of those is missing, unless the person allowed it with --allow-exec', () => {
    for (const weaker of [{ ...container, noNetwork: false }, { ...container, readOnlyRepository: false }, { ...container, startedByEngine: false }, {}]) {
      expect(decide(run(weaker), world(), grants('--active', '--allow-writes', '--allow-disrupt'))).toMatchObject({ answer: 'refuse', rule: 'ceiling.execute.refused', missing: [] });
      expect(decide(run(weaker), world(), grants('--allow-exec'))).toMatchObject({ answer: 'allow', rule: 'ceiling.execute.allow-exec' });
    }
  });
});
