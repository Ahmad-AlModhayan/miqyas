// SPDX-License-Identifier: AGPL-3.0-only
// Building the run facts for a caller (ticket 78): every entry the gate cannot read is reported, so the person who
// wrote it can be told, and the facts handed back are the ones the gate then refuses on.

import { describe, expect, it } from 'vitest';
import { decide, runFactsFrom } from '../../src/gate/decide/index.js';
import { O, everyGrant, pageGet, probeSent, world } from '../gate-helpers.js';

describe('runFactsFrom', () => {
  it('reports nothing for facts it can read, and hands them back as they are', () => {
    const built = runFactsFrom(world());
    expect(built.unreadable).toEqual([]);
    expect(built.facts).toEqual(world());
  });

  it('reports each entry of livePhysical that cannot be read as an origin, with where it is', () => {
    const built = runFactsFrom(world({ livePhysical: ['http://line-controller.test:502', 'line-controller.test:502', 'line-controller.test', 502 as never] }));
    expect(built.unreadable).toEqual([
      { list: 'livePhysical', index: 1, entry: 'line-controller.test:502', why: 'not-an-origin' },
      { list: 'livePhysical', index: 2, entry: 'line-controller.test', why: 'not-an-origin' },
      { list: 'livePhysical', index: 3, entry: 502, why: 'not-an-origin' },
    ]);
  });

  it('reports each entry of spendingRoutes and seenToChange that cannot be read as a route', () => {
    const built = runFactsFrom(world({ spendingRoutes: ['https://app.test/pay', '/pay'], seenToChange: ['localhost:4000/pay'] }));
    expect(built.unreadable).toEqual([
      { list: 'spendingRoutes', index: 1, entry: '/pay', why: 'not-a-route' },
      { list: 'seenToChange', index: 0, entry: 'localhost:4000/pay', why: 'not-a-route' },
    ]);
  });

  it('reports a list that is missing or is not a list', () => {
    const facts = { ...world(), seenToChange: 'https://app.test/pay' } as Record<string, unknown>;
    delete facts.livePhysical;
    expect(runFactsFrom(facts).unreadable).toEqual([
      { list: 'seenToChange', index: null, entry: 'https://app.test/pay', why: 'not-a-list' },
      { list: 'livePhysical', index: null, entry: undefined, why: 'not-a-list' },
    ]);
  });

  it.each([null, 42, 'facts', []])('reports facts that are not an object (%j)', (input) => {
    expect(runFactsFrom(input).unreadable).toEqual([{ list: null, index: null, entry: input, why: 'not-an-object' }]);
  });

  it('hands back facts the gate refuses on, never facts with the unreadable entry dropped', () => {
    const physical = runFactsFrom(world({ livePhysical: ['line-controller.test'] }));
    expect(decide(probeSent('POST', `${O.sandbox}/x`, 'write'), physical.facts, everyGrant())).toMatchObject({
      answer: 'refuse',
      rule: 'deny.live-physical-unreadable',
    });
    const noList = { ...world() } as Record<string, unknown>;
    delete noList.livePhysical;
    expect(decide(pageGet(`${O.sandbox}/`), runFactsFrom(noList).facts, everyGrant())).toMatchObject({
      answer: 'refuse',
      rule: 'refuse.unreadable-run-facts',
    });
  });
});
