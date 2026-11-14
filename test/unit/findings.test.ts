// SPDX-License-Identifier: AGPL-3.0-only
// Unit tests for Findings pipeline (--fail-on threshold, surface finding ingestion, ledger independence, and scrubbing).

import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PNG } from 'pngjs';
import { afterEach, describe, expect, it } from 'vitest';
import { findingsExceedThreshold, parseFailOn, type Finding } from '../../src/proof-core/findings.js';
import { runVerification } from '../../src/proof-core/orchestrator.js';
import { parsePlan } from '../../src/proof-core/plan.js';
import { renderHuman, renderMarkdown } from '../../src/proof-core/report.js';
import { parseScrubRules } from '../../src/scrub/scrub.js';
import type { Observation, SurfaceDriver, SurfaceFinding, SurfaceSession } from '../../src/surfaces/session.js';
import {
  detectFocusTrapFromTrace,
  findRedirectCandidates,
  scanTextForSecrets,
} from '../../src/surfaces/web/detectors.js';
import { schemaErrors } from '../report-helpers.js';

const temps: string[] = [];
afterEach(async () => {
  while (temps.length) await rm(temps.pop()!, { recursive: true, force: true });
});

function tinyPng(): Buffer {
  const png = new PNG({ width: 16, height: 16 });
  png.data.fill(210);
  return PNG.sync.write(png);
}

function driverWithFindings(findingsByCapture: Record<number, SurfaceFinding[]>, url = 'http://app.local/'): SurfaceDriver {
  let capture = 0;
  const obs = (c: number): Observation => ({
    capture: c,
    url,
    title: 'App',
    lang: 'en',
    dir: 'ltr',
    viewport: { width: 1280, height: 800 },
    nodes: [
      {
        ref: `c${c}e1`,
        role: 'heading',
        name: 'Dashboard',
        depth: 1,
        box: { x: 0, y: 0, width: 120, height: 24 },
        state: '',
        locator: "getByRole('heading', { name: 'Dashboard' })",
      },
    ],
    truncated: false,
    png: tinyPng(),
    capturedAt: new Date('2026-11-13T10:00:00Z'),
    ...(findingsByCapture[c] ? { findings: findingsByCapture[c] } : {}),
  });

  return {
    surface: 'web',
    version: 'fake-1.0',
    async openSession(): Promise<SurfaceSession> {
      return {
        async observe() {
          capture += 1;
          return obs(capture);
        },
        async act() {
          capture += 1;
          return { ok: true, message: 'ok', observation: obs(capture) };
        },
        async check() {
          const cur = obs(capture);
          return { pass: true, observation: 'heading visible', nodes: cur.nodes };
        },
        async wait() {
          capture += 1;
          return obs(capture);
        },
        async close() {},
      };
    },
    async close() {},
  };
}

describe('parseFailOn & severity threshold matching', () => {
  it('validates allowed thresholds and defaults to none', () => {
    expect(parseFailOn(undefined)).toBe('none');
    expect(parseFailOn('none')).toBe('none');
    expect(parseFailOn('HIGH')).toBe('high');
    expect(parseFailOn('Critical')).toBe('critical');
    expect(() => parseFailOn('bogus')).toThrow(/--fail-on/);
  });

  it('matches confirmed findings at or above severity threshold and ignores unconfirmed ones', () => {
    const sample: Finding[] = [
      { id: 'f1', category: 'a11y', title: 'Low contrast', severity: 'low', source: 'code', confirmed: true, evidence: 'contrast 3.2' },
      { id: 'f2', category: 'console-error', title: 'Uncaught TypeError', severity: 'high', source: 'code', confirmed: true, evidence: 'TypeError: x' },
      { id: 'f3', category: 'model-guess', title: 'Possible bug', severity: 'critical', source: 'model', confirmed: false, evidence: 'maybe' },
    ];
    expect(findingsExceedThreshold(sample, 'none')).toEqual([]);
    expect(findingsExceedThreshold(sample, 'high').map((f) => f.id)).toEqual(['f2']);
    expect(findingsExceedThreshold(sample, 'low').map((f) => f.id)).toEqual(['f1', 'f2']);
    expect(findingsExceedThreshold(sample, 'critical')).toEqual([]);
  });
});

describe('Findings pipeline in runVerification', () => {
  it('ingests surface findings, scrubs secrets, keeps ledger independent, and gates only on --fail-on', async () => {
    const plan = parsePlan(
      {
        format: 'miqyas-plan',
        version: 1,
        id: 'p1',
        name: 'Clean flow',
        steps: [
          { id: 'a1', type: 'assertion', text: "'Dashboard' is shown (ignores ${secret.TOKEN})", check: { locator: { role: 'heading', name: 'Dashboard' }, expect: 'visible' } },
        ],
      },
      'p1',
    );
    const findings: SurfaceFinding[] = [
      {
        category: 'http-error',
        title: 'HTTP 500 on /api/top-secret-token',
        severity: 'high',
        confirmed: true,
        url: 'http://app.local/?k=top-secret-token',
        evidence: '500 Internal Server Error for /api/top-secret-token',
        nodes: [{ ref: 'c1e1', role: 'button', name: 'Leak top-secret-token', box: { x: 0, y: 0, width: 40, height: 20 } }],
      },
      {
        category: 'clipping',
        title: 'Clipped label',
        severity: 'low',
        confirmed: true,
        evidence: 'scrollWidth 140 > clientWidth 80',
      },
    ];
    const scrub = parseScrubRules({ terms: [] }, 'rules.json');
    const env = { MIQYAS_SECRET_TOKEN: 'top-secret-token' };

    const runNone = await mkdtemp(path.join(os.tmpdir(), 'miqyas-fnone-'));
    temps.push(runNone);
    const resDefault = await runVerification({
      runId: 'f-none',
      url: 'http://app.local/',
      plans: [plan],
      runDir: runNone,
      driver: driverWithFindings({ 1: findings }),
      agent: null,
      noModel: true,
      scrub,
      scrubMethod: { file: null, sha256: null, terms: 0 },
      env,
    });

    expect(resDefault.verdict).toBe('pass');
    expect(resDefault.exitCode).toBe(0);
    expect(resDefault.plans[0]!.verdict).toBe('pass');
    expect(resDefault.findings).toHaveLength(2);
    expect(JSON.stringify(resDefault.report)).not.toContain('top-secret-token');
    expect(schemaErrors('report', resDefault.report)).toEqual([]);

    const runCritical = await mkdtemp(path.join(os.tmpdir(), 'miqyas-fcrit-'));
    temps.push(runCritical);
    const resCritical = await runVerification({
      runId: 'f-crit',
      url: 'http://app.local/',
      plans: [plan],
      runDir: runCritical,
      driver: driverWithFindings({ 1: findings }),
      agent: null,
      noModel: true,
      scrub,
      scrubMethod: { file: null, sha256: null, terms: 1 },
      settings: { failOn: 'critical' },
    });
    expect(resCritical.verdict).toBe('pass');
    expect(resCritical.exitCode).toBe(0);
    expect(resCritical.report.method.settings.failOn).toBe('critical');

    const runHigh = await mkdtemp(path.join(os.tmpdir(), 'miqyas-fhigh-'));
    temps.push(runHigh);
    const resHigh = await runVerification({
      runId: 'f-high',
      url: 'http://app.local/',
      plans: [plan],
      runDir: runHigh,
      driver: driverWithFindings({ 1: findings }),
      agent: null,
      noModel: true,
      scrub,
      scrubMethod: { file: null, sha256: null, terms: 1 },
      settings: { failOn: 'high' },
    });

    expect(resHigh.verdict).toBe('fail');
    expect(resHigh.exitCode).toBe(1);
    expect(resHigh.report.totals.plansPassed).toBe(1);
    expect(resHigh.plans[0]!.verdict).toBe('pass');
    expect(schemaErrors('report', resHigh.report)).toEqual([]);
    const md = renderMarkdown(resHigh.report);
    expect(md).toContain('## Findings');
    expect(md).toContain('fail-on high');
    expect(renderHuman(resHigh.report)).toContain('fail-on high');
  });
});

describe('Pure web detector helpers', () => {
  it('detects provider-prefixed secret patterns and masks evidence so raw tokens never leak', () => {
    const fakeAws = 'AKIA234567ABCDEFGHJK';
    const fakeGh = 'ghp_' + 'a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8';
    const bundle = `window.__CFG={aws:"${fakeAws}",gh:"${fakeGh}"};`;
    const hits = scanTextForSecrets(bundle, 'script /bundle.js', (s) => s);
    expect(hits.length).toBe(2);
    expect(hits.every((h) => h.category === 'secret-exposure' && h.confirmed)).toBe(true);
    for (const h of hits) {
      expect(h.evidence).not.toContain(fakeAws);
      expect(h.evidence).not.toContain(fakeGh);
    }
    // Normal text does not trigger noisy matches.
    expect(scanTextForSecrets('const apiKeyLabel = "Sign in";', 'script /app.js', (s) => s)).toEqual([]);
  });

  it('detects pinned focus traps and non-modal focus cycles from Tab traces', () => {
    expect(
      detectFocusTrapFromTrace(
        [
          { key: 'BODY', tag: 'BODY', label: 'body', inModal: false },
          { key: 'el#trap', tag: 'BUTTON', label: 'Locked', inModal: false },
          { key: 'el#trap', tag: 'BUTTON', label: 'Locked', inModal: false },
        ],
        3,
      ),
    ).toMatchObject({ category: 'focus-trap', severity: 'high', confirmed: true });

    expect(
      detectFocusTrapFromTrace(
        [
          { key: 'BODY', tag: 'BODY', label: 'body', inModal: false },
          { key: 'el#1', tag: 'BUTTON', label: 'One', inModal: false },
          { key: 'el#2', tag: 'BUTTON', label: 'Two', inModal: false },
          { key: 'BODY', tag: 'BODY', label: 'body', inModal: false },
        ],
        2,
      ),
    ).toBeNull();
  });

  it('extracts seen same-origin redirect query parameters for off-origin canary probing', () => {
    const base = 'http://127.0.0.1:4000';
    const candidates = findRedirectCandidates(
      ['http://127.0.0.1:4000/login?next=/dashboard&tab=info', 'http://127.0.0.1:4000/go?target=https://127.0.0.1:4000/ok', 'https://other.example/login?next=/x'],
      base,
    );
    expect(candidates.map((c) => `${c.pathname}|${c.param}`)).toEqual(['/login|next', '/go|target']);
    expect(candidates[0]!.probeUrl).toContain('canary.miqyas-probe.invalid');
  });
});
