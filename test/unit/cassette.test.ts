// SPDX-License-Identifier: PolyForm-Shield-1.0.0
// Deterministic cassette record/replay, ephemeral normalization, image fingerprinting, and miss tests (issue #11).

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PNG } from 'pngjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AgentError, type ActTool, type Agent, type JudgeOutcome, type ModelInfo } from '../../src/agents/agent.js';
import { RecordingAgent, ReplayAgent, ReplayMissError } from '../../src/agents/cassette.js';
import { parsePlan } from '../../src/proof-core/plan.js';
import { NO_SCRUB, parseScrubRules, ruleHits, scrubText } from '../../src/scrub/scrub.js';
import type { Observation } from '../../src/surfaces/session.js';

let tmp: string;
beforeAll(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'miqyas-cassette-'));
});
afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

function makePng(variant: 'light' | 'dark' | 'striped' = 'light'): Buffer {
  const img = new PNG({ width: 16, height: 16 });
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const idx = (y * 16 + x) * 4;
      const v =
        variant === 'light'
          ? 240 - x * 4
          : variant === 'dark'
            ? 20 + x * 4
            : x % 2 === 0
              ? 10
              : 250;
      img.data[idx] = v;
      img.data[idx + 1] = v;
      img.data[idx + 2] = v;
      img.data[idx + 3] = 255;
    }
  }
  return PNG.sync.write(img);
}

function makeObs(opts: { capture: number; port?: number; names: string[]; pngVariant?: 'light' | 'dark' | 'striped'; boxYOffset?: number; capturedAt?: Date }): Observation {
  const nodes = opts.names.map((name, i) => ({
    ref: `c${opts.capture}e${i + 1}`,
    role: i === 0 ? 'textbox' : 'status',
    name,
    depth: 0,
    box: { x: 10, y: (opts.boxYOffset ?? 0) + i * 24, width: 120, height: 20 },
    state: '',
    locator: '',
  }));
  return {
    capture: opts.capture,
    url: `http://127.0.0.1:${opts.port ?? 4173}/app`,
    title: 'Fixture',
    lang: 'en',
    dir: 'ltr',
    viewport: { width: 800, height: 600 },
    nodes,
    truncated: false,
    png: makePng(opts.pngVariant ?? 'light'),
    capturedAt: opts.capturedAt ?? new Date('2026-11-13T10:00:00Z'),
  };
}

function samplePlan(actionText = "Type alice into 'Name'") {
  return parsePlan(
    {
      format: 'miqyas-plan',
      version: 1,
      id: 'login',
      name: 'Sign in',
      steps: [
        { id: 's1', type: 'action', text: actionText },
        { id: 'a1', type: 'assertion', text: "'Signed in' is shown" },
      ],
    },
    'login',
  );
}

describe('cassette record and replay at the Agent seam', () => {
  it('records act and judge interactions tagged with run tier without PNG pixel bytes, and replays across shifted capture numbers and ports', async () => {
    const cassettePath = path.join(tmp, 'roundtrip.jsonl');
    const executedRecord: ActTool[] = [];
    const inner: Agent = {
      info: { provider: 'anthropic', model: 'claude-haiku-5-5', tier: 'low', effort: 'medium' },
      usage: { calls: 0, inputTokens: 0, outputTokens: 0 },
      async act(ctx) {
        const ref = ctx.observation.nodes[0]!.ref;
        const tool: ActTool = { tool: 'fill', ref, text: 'alice' };
        executedRecord.push(tool);
        await ctx.execute(tool);
        return { status: 'done', summary: `Filled ${ref}` };
      },
      async judge(ctx) {
        const later = await ctx.lookAgain(2);
        const statusRef = later.nodes[1]!.ref;
        return { verdict: 'pass', observation: `Visible at ${statusRef}`, evidenceRefs: [statusRef] } as JudgeOutcome;
      },
    };

    const recorder = new RecordingAgent(inner, { cassettePath });
    const p = samplePlan();
    const base = {
      plan: { id: p.id, name: p.name },
      history: [],
      scrub: (t: string) => scrubText(t, NO_SCRUB),
      rescan: (t: string) => ruleHits(t, NO_SCRUB),
    };

    await recorder.act({
      ...base,
      step: p.steps[0]!,
      observation: makeObs({ capture: 1, port: 4100, names: ['Name', 'Idle'] }),
      execute: async (a) => ({ ok: true, message: `filled ${'ref' in a ? a.ref : ''}`, observation: makeObs({ capture: 2, port: 4100, names: ['Name', 'Signed in'] }) }),
    });
    await recorder.judge({
      ...base,
      step: p.steps[1]!,
      postAction: makeObs({ capture: 2, port: 4100, names: ['Name', 'Signed in'], capturedAt: new Date('2026-11-13T10:00:00Z') }),
      current: makeObs({ capture: 3, port: 4100, names: ['Name', 'Signed in'], capturedAt: new Date('2026-11-13T10:00:01.200Z') }),
      lookAgain: async () => makeObs({ capture: 4, port: 4100, names: ['Name', 'Signed in'] }),
    });

    const raw = await readFile(cassettePath, 'utf8');
    const lines = raw.trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines[0]).toMatchObject({ type: 'header', cassetteSchema: 1, tier: 'low', model: 'claude-haiku-5-5', provider: 'anthropic' });
    expect(raw).not.toContain('data:image/png');
    expect(lines.filter((l) => l.type === 'call')).toHaveLength(4);

    // Replay with completely different capture counters (c8e1..c11e2), random ephemeral port (59999), and longer elapsed time.
    const replayer = await ReplayAgent.fromFile(cassettePath);
    expect(replayer.info).toMatchObject({ provider: 'anthropic', model: 'claude-haiku-5-5', tier: 'low' });
    const replayedActions: ActTool[] = [];

    const actOut = await replayer.act({
      ...base,
      step: p.steps[0]!,
      observation: makeObs({ capture: 8, port: 59999, names: ['Name', 'Idle'] }),
      execute: async (a) => {
        replayedActions.push(a);
        return { ok: true, message: `filled ${'ref' in a ? a.ref : ''}`, observation: makeObs({ capture: 9, port: 59999, names: ['Name', 'Signed in'] }) };
      },
    });
    expect(replayedActions).toEqual([{ tool: 'fill', ref: 'c8e1', text: 'alice' }]);
    expect(actOut.status).toBe('done');

    const judgeOut = await replayer.judge({
      ...base,
      step: p.steps[1]!,
      postAction: makeObs({ capture: 9, port: 59999, names: ['Name', 'Signed in'], capturedAt: new Date('2026-11-13T12:00:00Z') }),
      current: makeObs({ capture: 10, port: 59999, names: ['Name', 'Signed in'], capturedAt: new Date('2026-11-13T12:00:04.700Z') }),
      lookAgain: async () => makeObs({ capture: 11, port: 59999, names: ['Name', 'Signed in'] }),
    });
    expect(judgeOut).toMatchObject({ verdict: 'pass', evidenceRefs: ['c11e2'] });
    expect(replayer.stats.hits).toBe(4);
    expect(replayer.stats.misses).toBe(0);
    expect(replayer.stats.imageMismatches).toBe(0);
  });

  it('fails closed on snapshot drift, tier mismatch, exhaustion, and visual-only PNG mismatch', async () => {
    const cassettePath = path.join(tmp, 'misses.jsonl');
    const info: ModelInfo = { provider: 'anthropic', model: 'claude-haiku-5-5', tier: 'low' };
    const inner: Agent = {
      info,
      usage: { calls: 0, inputTokens: 0, outputTokens: 0 },
      async act() {
        return { status: 'done', summary: 'Done' };
      },
      async judge() {
        return { verdict: 'pass', observation: 'Ok', evidenceRefs: [] };
      },
    };
    const p = samplePlan();
    const base = {
      plan: { id: p.id, name: p.name },
      history: [],
      scrub: (t: string) => scrubText(t, NO_SCRUB),
      rescan: (t: string) => ruleHits(t, NO_SCRUB),
    };
    const recorder = new RecordingAgent(inner, { cassettePath });
    await recorder.act({
      ...base,
      step: p.steps[0]!,
      observation: makeObs({ capture: 1, names: ['Name', 'Idle'], pngVariant: 'light' }),
      execute: async () => ({ ok: true, message: 'ok', observation: makeObs({ capture: 2, names: ['Name', 'Idle'] }) }),
    });

    // 1. Different snapshot text -> ReplayMissError
    const r1 = await ReplayAgent.fromFile(cassettePath);
    await expect(
      r1.act({
        ...base,
        step: p.steps[0]!,
        observation: makeObs({ capture: 1, names: ['Email', 'Idle'], pngVariant: 'light' }),
        execute: async () => ({ ok: true, message: 'ok', observation: makeObs({ capture: 2, names: ['Email', 'Idle'] }) }),
      }),
    ).rejects.toThrow(ReplayMissError);

    // 2. Different tier -> ReplayMissError
    await expect(ReplayAgent.fromFile(cassettePath, { tier: 'high' })).rejects.toThrow(ReplayMissError);

    // 3. Repeating beyond recorded occurrences -> ReplayMissError
    const r2 = await ReplayAgent.fromFile(cassettePath);
    await r2.act({
      ...base,
      step: p.steps[0]!,
      observation: makeObs({ capture: 1, names: ['Name', 'Idle'], pngVariant: 'light' }),
      execute: async () => ({ ok: true, message: 'ok', observation: makeObs({ capture: 2, names: ['Name', 'Idle'] }) }),
    });
    await expect(
      r2.act({
        ...base,
        step: p.steps[0]!,
        observation: makeObs({ capture: 1, names: ['Name', 'Idle'], pngVariant: 'light' }),
        execute: async () => ({ ok: true, message: 'ok', observation: makeObs({ capture: 2, names: ['Name', 'Idle'] }) }),
      }),
    ).rejects.toThrow(ReplayMissError);

    // 4. Visual-only screenshot change (striped gradient flips dHash > threshold despite identical snapshot text) -> ReplayMissError
    const r3 = await ReplayAgent.fromFile(cassettePath);
    await expect(
      r3.act({
        ...base,
        step: p.steps[0]!,
        observation: makeObs({ capture: 1, names: ['Name', 'Idle'], pngVariant: 'striped' }),
        execute: async () => ({ ok: true, message: 'ok', observation: makeObs({ capture: 2, names: ['Name', 'Idle'] }) }),
      }),
    ).rejects.toThrow(ReplayMissError);
  });

  it('refuses to record unscrubbed text into cassette.jsonl', async () => {
    const cassettePath = path.join(tmp, 'unscrubbed.jsonl');
    const rules = parseScrubRules({ version: 1, terms: [{ from: 'TopSecret', to: 'Redacted' }] }, 'r.json');
    const inner: Agent = {
      info: { provider: 'anthropic', model: 'claude-haiku-5-5', tier: 'low' },
      usage: { calls: 0, inputTokens: 0, outputTokens: 0 },
      async act() {
        return { status: 'done', summary: 'Saw TopSecret on page' };
      },
      async judge() {
        return { verdict: 'pass', observation: 'ok', evidenceRefs: [] };
      },
    };
    const p = samplePlan();
    const recorder = new RecordingAgent(inner, { cassettePath });
    await expect(
      recorder.act({
        plan: { id: p.id, name: p.name },
        history: [],
        step: p.steps[0]!,
        observation: makeObs({ capture: 1, names: ['Home'] }),
        scrub: (t) => t,
        rescan: (t) => ruleHits(t, rules),
        execute: async () => ({ ok: true, message: 'ok', observation: makeObs({ capture: 2, names: ['Home'] }) }),
      }),
    ).rejects.toThrow(AgentError);
  });

  it('preserves multi-step history refs and denormalizes act/judge outcomes under shifted capture counters', async () => {
    const cassettePath = path.join(tmp, 'multistep.jsonl');
    const p = samplePlan();
    const inner: Agent = {
      info: { provider: 'anthropic', model: 'claude-haiku-5-5', tier: 'low', effort: 'medium' },
      usage: { calls: 0, inputTokens: 0, outputTokens: 0 },
      async act({ observation }) {
        return { status: 'done', summary: `Clicked target ${observation.nodes[0]?.ref}` };
      },
      async judge({ current }) {
        return {
          verdict: 'pass',
          observation: `Confirmed ${current.nodes[0]?.ref} and ${current.nodes[1]?.ref}`,
          evidenceRefs: [current.nodes[0]!.ref],
        };
      },
    };
    const base = {
      plan: { id: p.id, name: p.name },
      scrub: (t: string) => scrubText(t, NO_SCRUB),
      rescan: (t: string) => ruleHits(t, NO_SCRUB),
    };

    const recorder = new RecordingAgent(inner, { cassettePath });
    const recAct = await recorder.act({
      ...base,
      history: [],
      step: p.steps[0]!,
      observation: makeObs({ capture: 1, names: ['Name', 'Idle'], pngVariant: 'light' }),
      execute: async () => ({ ok: true, message: 'ok', observation: makeObs({ capture: 2, names: ['Name', 'Idle'] }) }),
    });
    expect(recAct).toEqual({ status: 'done', summary: 'Clicked target c1e1' });

    await recorder.judge({
      ...base,
      history: [{ stepId: p.steps[0]!.id, type: 'action', text: p.steps[0]!.text, result: `done: ${recAct.summary}` }],
      step: p.steps[1]!,
      postAction: makeObs({ capture: 1, names: ['Name', 'Idle'], pngVariant: 'light' }),
      current: makeObs({ capture: 2, names: ['Name', 'Idle'], pngVariant: 'dark' }),
      lookAgain: async () => makeObs({ capture: 3, names: ['Name', 'Idle'], pngVariant: 'dark' }),
    });

    const replay = await ReplayAgent.fromFile(cassettePath);
    const repAct = await replay.act({
      ...base,
      history: [],
      step: p.steps[0]!,
      observation: makeObs({ capture: 8, names: ['Name', 'Idle'], pngVariant: 'light' }),
      execute: async () => {
        throw new Error('execute should not run for single-turn done');
      },
    });
    expect(repAct).toEqual({ status: 'done', summary: 'Clicked target c8e1' });

    const repJudge = await replay.judge({
      ...base,
      history: [{ stepId: p.steps[0]!.id, type: 'action', text: p.steps[0]!.text, result: `done: ${repAct.summary}` }],
      step: p.steps[1]!,
      postAction: makeObs({ capture: 8, names: ['Name', 'Idle'], pngVariant: 'light' }),
      current: makeObs({ capture: 15, names: ['Name', 'Idle'], pngVariant: 'dark' }),
      lookAgain: async () => makeObs({ capture: 16, names: ['Name', 'Idle'], pngVariant: 'dark' }),
    });
    expect(repJudge).toEqual({
      verdict: 'pass',
      observation: 'Confirmed c15e1 and c15e2',
      evidenceRefs: ['c15e1'],
    });
  });

  it('fails closed on corrupt cassette records, header/flag mismatches, duplicate slots, and unscrubbed replay requests', async () => {
    const p = samplePlan();
    const validPath = path.join(tmp, 'valid-hdr.jsonl');
    const inner: Agent = {
      info: { provider: 'anthropic', model: 'claude-haiku-5-5', tier: 'low', effort: 'medium' },
      usage: { calls: 0, inputTokens: 0, outputTokens: 0 },
      async act() {
        return { status: 'done', summary: 'ok' };
      },
      async judge() {
        return { verdict: 'pass', observation: 'ok', evidenceRefs: [] };
      },
    };
    const rec = new RecordingAgent(inner, { cassettePath: validPath });
    await rec.act({
      plan: { id: p.id, name: p.name },
      history: [],
      step: p.steps[0]!,
      observation: makeObs({ capture: 1, names: ['Name'], pngVariant: 'light' }),
      scrub: (t) => scrubText(t, NO_SCRUB),
      rescan: (t) => ruleHits(t, NO_SCRUB),
      execute: async () => ({ ok: true, message: 'ok', observation: makeObs({ capture: 2, names: ['Name'] }) }),
    });

    await expect(ReplayAgent.fromFile(validPath, { provider: 'openai' })).rejects.toThrow(ReplayMissError);
    await expect(ReplayAgent.fromFile(validPath, { effort: 'max' })).rejects.toThrow(ReplayMissError);

    const lines = (await readFile(validPath, 'utf8')).trim().split('\n');
    const header = JSON.parse(lines[0]!);
    const call = JSON.parse(lines[1]!);

    // Missing header provider
    const noProvPath = path.join(tmp, 'no-prov.jsonl');
    await writeFile(noProvPath, JSON.stringify({ ...header, provider: undefined }) + '\n' + lines[1]! + '\n');
    await expect(ReplayAgent.fromFile(noProvPath)).rejects.toThrow(ReplayMissError);

    // Corrupt dHash
    const badHashPath = path.join(tmp, 'bad-dhash.jsonl');
    await writeFile(
      badHashPath,
      lines[0]! + '\n' + JSON.stringify({ ...call, images: [{ label: 'obs', dHash: 'not-hex' }] }) + '\n',
    );
    await expect(ReplayAgent.fromFile(badHashPath)).rejects.toThrow(ReplayMissError);

    // Duplicate (key, occurrence)
    const dupPath = path.join(tmp, 'dup-slot.jsonl');
    await writeFile(dupPath, [lines[0]!, lines[1]!, lines[1]!].join('\n') + '\n');
    await expect(ReplayAgent.fromFile(dupPath)).rejects.toThrow(ReplayMissError);

    // Unscrubbed replay request blocked by rescan before lookup
    const r = await ReplayAgent.fromFile(validPath);
    const secretRules = parseScrubRules({ version: 1, terms: [{ from: 'LeakedSecret', to: 'Redacted' }] }, 's.json');
    await expect(
      r.act({
        plan: { id: p.id, name: p.name },
        history: [],
        step: p.steps[0]!,
        observation: makeObs({ capture: 1, names: ['LeakedSecret'], pngVariant: 'light' }),
        scrub: (t) => t,
        rescan: (t) => ruleHits(t, secretRules),
        execute: async () => ({ ok: true, message: 'ok', observation: makeObs({ capture: 2, names: ['LeakedSecret'] }) }),
      }),
    ).rejects.toThrow(AgentError);
  });
});
