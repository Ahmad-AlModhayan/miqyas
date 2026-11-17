// SPDX-License-Identifier: AGPL-3.0-only
// The deny rules: each never-do line of the threat model (and the lines that come with the foundation and the
// experiment engine) is a rule with an id. Each test passes every grant, names every host, puts the owner's token
// everywhere, and the effect is still refused by that rule. Each test also shows that a nearby effect that keeps
// the rule is allowed, so the refusal is the rule's and not the grants'.

import { describe, expect, it } from 'vitest';
import { DENY_RULES, decide, type Effect } from '../../src/gate/decide/index.js';
import { O, everyGrant, inertProbe, pageGet, probeSent, request, world } from '../gate-helpers.js';

// Every grant, and the token found on every host a test uses.
const strong = () => world({ ownershipTokenHosts: ['shop.example.com', 'staging.example.com', 'line-controller.test'] });
const refusedBy = (effect: Effect, id: string) =>
  expect(decide(effect, strong(), everyGrant())).toMatchObject({ answer: 'refuse', rule: id });
const allowed = (effect: Effect) => expect(decide(effect, strong(), everyGrant()).answer).toBe('allow');

describe('the list of deny rules', () => {
  it('has the stable ids, in the order they are checked, each with the line it comes from', () => {
    expect(DENY_RULES.map((r) => [r.id, r.source])).toEqual([
      ['deny.leave-the-run', 'never leave the set of origins the run is about: the target’s origin and the backends its own pages call'],
      ['deny.foreign-origin-active', 'never probe, write to or disrupt an origin that isn’t a sandbox, a test host, an owned host or the backend of one'],
      ['deny.live-physical-process', 'never write to or disrupt a live physical process, whatever the flags and whoever owns it'],
      ['deny.capsule-outside-sandbox', 'capturing, restoring and forking are refused on any origin that isn’t a sandbox, whatever was granted'],
      ['deny.seed-outside-public-corpus', 'seeds are planted only in copies of the public corpus'],
      ['deny.brute-force-login', 'never brute-force a login'],
      ['deny.get-past-challenge', 'never get past a CAPTCHA or WAF (it stops and reports instead)'],
      ['deny.upload-unnamed-file', 'never upload a file no plan names'],
      ['deny.run-page-or-model-code', 'never run page or model code in Node'],
      ['deny.send-page-data', 'never send page data anywhere but the scrubbed model call'],
      ['deny.type-unnamed-secret', 'never type a secret the step doesn’t name'],
      ['deny.probe-not-inert', 'Miqyas’s own probes send inert markers only, on every origin that isn’t a sandbox'],
      ['deny.second-account-writes', 'the second account only reads, on every origin that isn’t a sandbox'],
      ['deny.probe-foreign-ids', 'a probe uses only ids the test accounts own, with no enumeration, on every origin that isn’t a sandbox'],
      ['deny.probe-untagged', 'what a target stores is tagged miqyas-probe-<run id>, on every origin that isn’t a sandbox'],
    ]);
  });
});

describe('never leave the set of origins the run is about', () => {
  it('refuses a request to an origin that is neither a target, a sandbox, nor a backend of one, even a read', () => {
    refusedBy(pageGet(`${O.unrelated}/`), 'deny.leave-the-run');
    refusedBy(pageGet('not a url'), 'deny.leave-the-run');
    refusedBy(probeSent('GET', `${O.unrelated}/x`, 'probe'), 'deny.leave-the-run');
    allowed(pageGet(`${O.sandbox}/`));
    allowed(pageGet(`${O.backendOfLocal}/`));
  });

  it('refuses it in a sandbox as well, since the never-do lines hold everywhere', () => {
    const w = world();
    expect(decide(pageGet(`${O.unrelated}/`), w, everyGrant()).rule).toBe('deny.leave-the-run');
  });
});

describe('never probe, write to or disrupt an origin that is not a sandbox, a test host, an owned host or the backend of one', () => {
  it('refuses a probe on another origin and on a backend of one', () => {
    refusedBy(probeSent('GET', `${O.other}/x`, 'probe'), 'deny.foreign-origin-active');
    refusedBy(probeSent('POST', `${O.other}/x`, 'write'), 'deny.foreign-origin-active');
    refusedBy(probeSent('GET', `${O.backendOfOther}/x`, 'probe'), 'deny.foreign-origin-active');
    refusedBy(probeSent('GET', `${O.other}/x`, 'disrupt', {}, { declared: 'disrupt' }), 'deny.foreign-origin-active');
    allowed(probeSent('GET', `${O.local}/x`, 'probe'));
    allowed(pageGet(`${O.other}/`));
  });
});

describe('never write to or disrupt a live physical process', () => {
  it('refuses a write or a disrupt on an origin known to drive one, with every grant and its token', () => {
    refusedBy(probeSent('POST', `${O.physical}/valve`, 'write'), 'deny.live-physical-process');
    refusedBy(probeSent('GET', `${O.physical}/x`, 'disrupt', {}, { declared: 'disrupt' }), 'deny.live-physical-process');
    refusedBy({ kind: 'capsule', operation: 'restore', origin: O.physical }, 'deny.live-physical-process');
    allowed(pageGet(`${O.physical}/status`));
    allowed(probeSent('GET', `${O.physical}/status`, 'probe'));
    allowed(probeSent('POST', `${O.local}/valve`, 'write'));
  });

  it('refuses it in a sandbox too: whoever owns it', () => {
    const w = world({ livePhysical: [O.sandbox] });
    expect(decide(probeSent('POST', `${O.sandbox}/x`, 'write'), w, everyGrant()).rule).toBe('deny.live-physical-process');
  });
});

describe('capture, restore and fork only in a sandbox', () => {
  it.each(['capture', 'restore', 'fork'] as const)('refuses %s on any origin that is not a sandbox', (operation) => {
    for (const k of ['local', 'named', 'owned', 'backendOfSandbox'] as const) {
      refusedBy({ kind: 'capsule', operation, origin: O[k] }, 'deny.capsule-outside-sandbox');
    }
    expect(decide({ kind: 'capsule', operation, origin: O.sandbox }, strong(), everyGrant())).toMatchObject({
      answer: 'allow',
      effectClass: 'disrupt',
      rule: 'ceiling.disrupt.sandbox',
    });
  });

  it('refuses an operation it does not know in the same way, so a new one cannot slip by', () => {
    refusedBy({ kind: 'capsule', operation: 'export' as never, origin: O.local }, 'deny.capsule-outside-sandbox');
  });
});

describe('seeds go only into copies of the public corpus', () => {
  it('refuses planting a seed on any other subject', () => {
    refusedBy({ kind: 'plant-seed', subject: 'other', origin: O.sandbox }, 'deny.seed-outside-public-corpus');
    refusedBy({ kind: 'plant-seed', subject: 'someones-app' as never, origin: O.sandbox }, 'deny.seed-outside-public-corpus');
    allowed({ kind: 'plant-seed', subject: 'public-corpus-copy', origin: O.sandbox });
  });
});

describe('never brute-force a login', () => {
  const login = (secret: 'named-by-step' | 'not-named', tried: number, k: keyof typeof O = 'sandbox') =>
    request({ method: 'POST', url: `${O[k]}/login`, cause: 'collector' }, 'write', {
      probe: inertProbe,
      loginAttempt: { secret, distinctSecretsTriedOnAccount: tried },
    });

  it('refuses a secret no step names, and a second distinct secret on the same account, on every origin', () => {
    for (const k of ['sandbox', 'local', 'owned'] as const) {
      refusedBy(login('not-named', 1, k), 'deny.brute-force-login');
      refusedBy(login('named-by-step', 2, k), 'deny.brute-force-login');
      allowed(login('named-by-step', 1, k));
    }
  });

  it('refuses a count of secrets tried that is not the number 1', () => {
    for (const tried of [0, -1, null, '1', true, Number.NaN]) {
      refusedBy(login('named-by-step', tried as never, 'local'), 'deny.brute-force-login');
    }
  });

  it('refuses what a collector sends itself off a sandbox when it does not say whether it is a login attempt', () => {
    const unsaid = (k: keyof typeof O) => request({ method: 'GET', url: `${O[k]}/x`, cause: 'collector' }, 'probe', { probe: inertProbe });
    for (const k of ['local', 'named', 'owned', 'backendOfSandbox'] as const) refusedBy(unsaid(k), 'deny.brute-force-login');
    allowed(unsaid('sandbox'));
    allowed(request({ method: 'GET', url: `${O.local}/x`, cause: 'collector' }, 'probe', { probe: inertProbe, loginAttempt: 'not-a-login' }));
    allowed(pageGet(`${O.local}/login`));
  });

  it('refuses a value for the login attempt that is neither an attempt nor the word that it is not one', () => {
    for (const odd of ['no', null, 1]) {
      refusedBy(request({ method: 'GET', url: `${O.local}/x`, cause: 'collector' }, 'probe', { probe: inertProbe, loginAttempt: odd }), 'deny.brute-force-login');
    }
  });
});

describe('never get past a CAPTCHA or a WAF', () => {
  it('refuses it, and stops', () => {
    for (const challenge of ['captcha', 'waf'] as const) {
      refusedBy({ kind: 'get-past-challenge', origin: O.sandbox, challenge }, 'deny.get-past-challenge');
    }
    refusedBy({ kind: 'get-past-challenge', origin: O.local, challenge: 'anything' as never }, 'deny.get-past-challenge');
  });
});

describe('never upload a file no plan names', () => {
  it('refuses an upload that no plan names', () => {
    refusedBy({ kind: 'upload-file', origin: O.sandbox, namedByPlan: false }, 'deny.upload-unnamed-file');
    refusedBy({ kind: 'upload-file', origin: O.local, namedByPlan: undefined as never }, 'deny.upload-unnamed-file');
    allowed({ kind: 'upload-file', origin: O.local, namedByPlan: true });
  });
});

describe('never run page or model code in Node', () => {
  it('refuses code from a page or a model, and from a source it does not know', () => {
    for (const source of ['page', 'model', 'a-plugin']) {
      refusedBy({ kind: 'run-code', source: source as never }, 'deny.run-page-or-model-code');
    }
    allowed({ kind: 'run-code', source: 'target', containment: { startedByEngine: true, noNetwork: true, readOnlyRepository: true } });
  });
});

describe('never send page data anywhere but the scrubbed model call', () => {
  it('refuses any other destination', () => {
    refusedBy({ kind: 'send-page-data', to: 'elsewhere' }, 'deny.send-page-data');
    refusedBy({ kind: 'send-page-data', to: 'a-webhook' as never }, 'deny.send-page-data');
    allowed({ kind: 'send-page-data', to: 'scrubbed-model-call' });
  });
});

describe('never type a secret the step does not name', () => {
  it('refuses it on every origin', () => {
    for (const k of ['sandbox', 'local'] as const) {
      refusedBy({ kind: 'type-secret', origin: O[k], namedByStep: false }, 'deny.type-unnamed-secret');
      allowed({ kind: 'type-secret', origin: O[k], namedByStep: true });
    }
  });
});

// The rules on Miqyas's own probes bind on every origin that isn't a sandbox.
describe('the limits on Miqyas’s own probes', () => {
  const offSandbox = ['local', 'named', 'owned', 'backendOfSandbox'] as const;

  it('allow inert markers only', () => {
    for (const k of offSandbox) refusedBy(probeSent('GET', `${O[k]}/x`, 'probe', { inertMarkersOnly: false }), 'deny.probe-not-inert');
    refusedBy(probeSent('GET', `${O.local}/x`, 'probe', null), 'deny.probe-not-inert');
    refusedBy(probeSent('GET', `${O.local}/x`, 'probe', { inertMarkersOnly: undefined as never }), 'deny.probe-not-inert');
    allowed(probeSent('GET', `${O.local}/x`, 'probe'));
    allowed(probeSent('GET', `${O.sandbox}/x`, 'probe', { inertMarkersOnly: false }));
  });

  it('let the second account only read', () => {
    for (const k of offSandbox) refusedBy(probeSent('POST', `${O[k]}/x`, 'write', { identity: 'second-account' }), 'deny.second-account-writes');
    allowed(probeSent('GET', `${O.local}/x`, 'probe', { identity: 'second-account' }));
    allowed(probeSent('POST', `${O.sandbox}/x`, 'write', { identity: 'second-account' }));
  });

  it('use only ids the test accounts own, with no enumeration', () => {
    for (const k of offSandbox) {
      refusedBy(probeSent('GET', `${O[k]}/items/9`, 'probe', { idsOwnedByTestAccounts: false }), 'deny.probe-foreign-ids');
      refusedBy(probeSent('GET', `${O[k]}/items/9`, 'probe', { enumeratesIds: true }), 'deny.probe-foreign-ids');
    }
    allowed(probeSent('GET', `${O.sandbox}/items/9`, 'probe', { idsOwnedByTestAccounts: false, enumeratesIds: true }));
  });

  it('tag what a target stores with the run id', () => {
    for (const k of offSandbox) refusedBy(probeSent('POST', `${O[k]}/x`, 'write', { taggedWithRunId: false }), 'deny.probe-untagged');
    allowed(probeSent('GET', `${O.local}/x`, 'probe', { taggedWithRunId: false }));
    allowed(probeSent('POST', `${O.sandbox}/x`, 'write', { taggedWithRunId: false }));
  });

  it('do not bind what a page sends: that is not Miqyas’s probe', () => {
    allowed(pageGet(`${O.local}/`));
  });
});
