// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
  CORPUS_CATEGORIES,
  CorpusError,
  judgeSeedProbe,
  lintCorpus,
  loadCorpusFromPath,
  parseCorpusManifest,
  parseKnownFindings,
} from '../../src/proof-core/corpus.js';
import { parsePlan } from '../../src/proof-core/plan.js';

function baseManifest(over: Record<string, unknown> = {}) {
  return {
    version: 1,
    target: 'mini-shop',
    cleanTwin: {
      buildDir: 'corpus/fixtures/mini-shop-clean',
      knownFindings: 'corpus/fixtures/mini-shop-clean/known-findings.json',
    },
    seeds: [
      {
        id: 'seed-flow-1',
        title: 'Checkout button text swapped',
        part: 'asserted',
        category: 'broken-flow',
        plan: '01-checkout',
        assertion: 'a1',
        mutation: { kind: 'string-swap', from: 'Complete Order', to: 'Unavailable' },
        probe: { measure: 'text', expectClean: 'Complete Order', expectSeed: 'Unavailable' },
      },
      {
        id: 'seed-secret-unasserted',
        title: 'Exposed fallback token in DOM',
        part: 'unasserted',
        category: 'secret-leak',
        blindTokens: ['sk_live_seeded_leak'],
        mutation: { kind: 'string-swap', from: 'Status: Ready', to: 'Status: sk_live_seeded_leak' },
        probe: { measure: 'text', expectClean: 'Status: Ready', expectSeed: 'sk_live_seeded_leak' },
      },
      {
        id: 'seed-css-readiness',
        title: 'Error banner hidden by CSS',
        part: 'readiness',
        category: 'css-visibility',
        readinessCheck: 'grade-1/hidden-errors',
        mutation: { kind: 'css', css: '.field-error{display:none}' },
        probe: {
          measure: 'height',
          selector: '#miqyas-probe',
          html: '<div class="field-error" id="miqyas-probe">err</div>',
        },
      },
    ],
    ...over,
  };
}

function validKnownFindings(over: Record<string, unknown> = {}) {
  return {
    version: 1,
    target: 'mini-shop',
    buildId: 'clean-v1',
    reviewedAt: '2026-11-13T10:00:00Z',
    reviewer: 'Kahf Labs',
    entries: [
      {
        id: 'kf-1',
        category: 'console-info',
        evidencePattern: 'DevTools',
        rationale: 'Harmless baseline fixture banner reviewed by QA.',
      },
    ],
    ...over,
  };
}

describe('corpus manifest, known-findings validation, and unasserted blindness lint (#15)', () => {
  it('defines all 10 canonical defect categories and parses valid manifests + known-findings baselines', () => {
    expect(CORPUS_CATEGORIES).toHaveLength(10);
    expect(new Set(CORPUS_CATEGORIES).size).toBe(10);

    const manifest = parseCorpusManifest(baseManifest());
    const known = parseKnownFindings(validKnownFindings());
    expect(manifest.seeds).toHaveLength(3);
    expect(known.entries).toHaveLength(1);

    const cleanPlan = parsePlan(
      {
        format: 'miqyas-plan',
        version: 1,
        id: '01-checkout',
        steps: [
          { id: 's1', type: 'action', text: 'Open checkout' },
          { id: 'a1', type: 'assertion', text: "'Complete Order' is visible" },
        ],
      },
      '01-checkout',
    );
    expect(() => lintCorpus(manifest, [cleanPlan], known)).not.toThrow();
  });

  it('rejects seeds without code effectiveness probes, unknown categories, unasserted plan fields, or missing readiness checks', () => {
    // Missing probe
    const noProbe = baseManifest({
      seeds: [
        {
          id: 'seed-1',
          title: 'Missing probe',
          part: 'asserted',
          category: 'broken-flow',
          plan: '01-checkout',
          assertion: 'a1',
        },
      ],
    });
    expect(() => parseCorpusManifest(noProbe)).toThrow(CorpusError);

    // Unknown defect category
    const badCategory = baseManifest({
      seeds: [
        {
          id: 'seed-1',
          title: 'Bad category',
          part: 'asserted',
          category: 'not-a-category',
          plan: '01-checkout',
          probe: { measure: 'text', expectClean: 'a', expectSeed: 'b' },
        },
      ],
    });
    expect(() => parseCorpusManifest(badCategory)).toThrow(/category/i);

    // Unasserted seed declaring a plan
    const leakySeed = baseManifest({
      seeds: [
        {
          id: 'seed-unasserted-leak',
          title: 'Should be blind',
          part: 'unasserted',
          category: 'secret-leak',
          plan: '01-checkout',
          probe: { measure: 'text', expectClean: 'a', expectSeed: 'b' },
        },
      ],
    });
    expect(() => parseCorpusManifest(leakySeed)).toThrow(/blind|plan/i);

    // Readiness seed without readinessCheck
    const noCheck = baseManifest({
      seeds: [
        {
          id: 'seed-r1',
          title: 'Missing check id',
          part: 'readiness',
          category: 'css-visibility',
          probe: { measure: 'height', selector: '#x' },
        },
      ],
    });
    expect(() => parseCorpusManifest(noCheck)).toThrow(/readinessCheck/i);
  });

  it('rejects invalid known-findings baselines', () => {
    expect(() => parseKnownFindings(validKnownFindings({ reviewer: '' }))).toThrow(CorpusError);
    expect(() =>
      parseKnownFindings(
        validKnownFindings({
          entries: [{ id: 'kf-1', category: 'a11y', evidencePattern: '', rationale: 'missing pattern' }],
        }),
      ),
    ).toThrow(CorpusError);
  });

  it('lint rejects any plan referencing an unasserted seed id, title, or blind token, and checks asserted plan refs', () => {
    const manifest = parseCorpusManifest(baseManifest());
    const known = parseKnownFindings(validKnownFindings());

    const leakyPlan = parsePlan(
      {
        format: 'miqyas-plan',
        version: 1,
        id: '01-checkout',
        steps: [
          { id: 's1', type: 'action', text: 'Check secret-leak' },
          { id: 'a1', type: 'assertion', text: "Ensure no 'sk_live_seeded_leak' is shown" },
        ],
      },
      '01-checkout',
    );
    expect(() => lintCorpus(manifest, [leakyPlan], known)).toThrow(/unasserted seed "seed-secret-unasserted"/i);

    const missingAssertionPlan = parsePlan(
      {
        format: 'miqyas-plan',
        version: 1,
        id: '01-checkout',
        steps: [{ id: 'a99', type: 'assertion', text: 'Other assertion' }],
      },
      '01-checkout',
    );
    expect(() => lintCorpus(manifest, [missingAssertionPlan], known)).toThrow(/assertion "a1"/i);

    const wrongTargetKnown = parseKnownFindings(validKnownFindings({ target: 'other-app' }));
    const goodPlan = parsePlan(
      {
        format: 'miqyas-plan',
        version: 1,
        id: '01-checkout',
        steps: [{ id: 'a1', type: 'assertion', text: "'Complete Order' is visible" }],
      },
      '01-checkout',
    );
    expect(() => lintCorpus(manifest, [goodPlan], wrongTargetKnown)).toThrow(/target/i);
  });

  it('judges seed code probes deterministically against clean vs broken readings', () => {
    const manifest = parseCorpusManifest(baseManifest());
    const [flowSeed, , cssSeed] = manifest.seeds;

    expect(judgeSeedProbe(flowSeed!, 'Complete Order\nTax 0', 'Unavailable\nTax 0').effective).toBe(true);
    expect(judgeSeedProbe(flowSeed!, 'Complete Order', 'Complete Order').effective).toBe(false);

    expect(judgeSeedProbe(cssSeed!, 24, 0).effective).toBe(true);
    expect(judgeSeedProbe(cssSeed!, 24, 24).effective).toBe(false);
    expect(judgeSeedProbe(cssSeed!, 0, 0).effective).toBe(false);
  });

  it('rejects path traversal in seed.id, off-origin probe.path, nested-quantifier regexes, and wraps missing corpus files in CorpusError', async () => {
    expect(() =>
      parseCorpusManifest(
        baseManifest({
          seeds: [
            {
              id: '../escape',
              title: 'Bad id',
              part: 'asserted',
              category: 'broken-flow',
              plan: 'p1',
              mutation: { kind: 'string-swap', from: 'a', to: 'b' },
              probe: { measure: 'text' },
            },
          ],
        }),
      ),
    ).toThrow(CorpusError);

    expect(() =>
      parseCorpusManifest(
        baseManifest({
          seeds: [
            {
              id: 'good-id',
              title: 'Off-origin probe path',
              part: 'asserted',
              category: 'broken-flow',
              plan: 'p1',
              mutation: { kind: 'string-swap', from: 'a', to: 'b' },
              probe: { measure: 'text', path: 'https://evil.example/' },
            },
          ],
        }),
      ),
    ).toThrow(/probe\.path/i);

    expect(() =>
      parseKnownFindings(
        validKnownFindings({
          entries: [{ id: 'kf-redos', category: 'a11y', evidencePattern: '(a+)+b', rationale: 'ReDoS check' }],
        }),
      ),
    ).toThrow(/nested or repeated quantifiers/i);

    await expect(loadCorpusFromPath('/nonexistent-miqyas-corpus-dir-999')).rejects.toThrow(CorpusError);
  });
});
