// SPDX-License-Identifier: PolyForm-Shield-1.0.0
// The payload path of the Anthropic agent, offline: a stubbed client, fake observations, no browser, no network.
import type Anthropic from '@anthropic-ai/sdk';
import { appendFileSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { PlanLedger } from '../../src/core/ledger.js';
import { parsePlan, secretNames } from '../../src/core/plan.js';
import { buildReport, renderMarkdown } from '../../src/core/report.js';
import { NO_SCRUB, parseScrubRules, ruleHits, scrubText, withSecrets, type ScrubRules } from '../../src/core/scrub.js';
import { AgentError, type PayloadEntry } from '../../src/model/agent.js';
import { AnthropicAgent } from '../../src/model/anthropic.js';
import type { Observation } from '../../src/web/observe.js';
import { schemaErrors, testMethod } from '../report-helpers.js';

const png = PNG.sync.write(new PNG({ width: 4, height: 4 }));

function obs(capture: number, names: string[]): Observation {
  const nodes = names.map((name, i) => ({ ref: `c${capture}e${i + 1}`, role: i === 0 ? 'textbox' : 'status', name, depth: 0, box: { x: 0, y: i * 10, width: 4, height: 4 }, state: '', locator: '' }));
  return { capture, url: 'http://127.0.0.1:4173/', title: 'Fixture', lang: 'en', dir: 'ltr', viewport: { width: 4, height: 4 }, nodes, truncated: false, png, capturedAt: new Date() };
}

type Reply = Anthropic.Beta.Messages.BetaContentBlock[];
const say = (text: string): Reply => [{ type: 'text', text, citations: null }] as Reply;
const use = (name: string, input: Record<string, unknown>): Reply => [{ type: 'tool_use', id: `t-${name}`, name, input }] as Reply;

/** A client that answers from a script and counts the calls it was sent. */
function stub(replies: Reply[], models: string[] = []) {
  const s = { calls: 0 };
  const client = {
    beta: {
      messages: {
        create: async () => {
          s.calls++;
          const content = replies.shift() ?? say('(script ended)');
          return { model: models.shift() ?? 'claude-opus-5-5', content, stop_reason: content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } };
        },
      },
    },
  } as unknown as Anthropic;
  return { s, client };
}

function plan(action: string) {
  return parsePlan(
    { format: 'miqyas-plan', version: 1, id: 'login', name: 'Sign in', steps: [{ id: 's1', type: 'action', text: action }, { id: 'a1', type: 'assertion', text: "'Signed in' is shown" }] },
    'login',
  );
}

function contexts(p: ReturnType<typeof plan>, rules: ScrubRules, page: string[], toolMessage = 'filled c1e1') {
  const base = { plan: { id: p.id, name: p.name }, history: [], scrub: (t: string) => scrubText(t, rules), rescan: (t: string) => ruleHits(t, rules) };
  return {
    act: { ...base, step: p.steps[0]!, observation: obs(1, page), execute: async () => ({ ok: true, message: toolMessage, observation: obs(2, page) }) },
    judge: { ...base, step: p.steps[1]!, current: obs(2, page), lookAgain: async () => obs(3, page) },
  };
}

describe('payload log', () => {
  it('writes exactly one entry per model call, nudges included, with images marked unscrubbed', async () => {
    const { s, client } = stub([say('Looking.'), use('fill', { ref: 'c1e1', text: 'x' }), use('step_done', { summary: 'filled' }), say('Hmm.'), use('record_verdict', { verdict: 'pass', observation: 'shown', evidence_refs: ['c2e2'] })]);
    const log: PayloadEntry[] = [];
    const agent = new AnthropicAgent({ client, log: (e) => log.push(e) });
    const p = plan("Type x into 'Name'");
    const c = contexts(p, NO_SCRUB, ['Name', 'Signed in']);
    expect(await agent.act(c.act)).toEqual({ status: 'done', summary: 'filled' });
    expect(await agent.judge(c.judge)).toMatchObject({ verdict: 'pass' });
    expect(s.calls).toBe(5);
    expect(log).toHaveLength(5);
    expect(log.map((e) => e.kind)).toEqual(['act', 'act', 'act', 'judge', 'judge']);
    expect(log[1]!.text).toContain('Call a tool');
    expect(log[4]!.text).toContain('Call record_verdict now.');
    expect(log[0]!.images).toEqual({ count: 1, scrubbed: false });
    expect(log[1]!.images).toEqual({ count: 0, scrubbed: false });
    expect(log[2]!.images).toEqual({ count: 1, scrubbed: false });
  });

  it('records the model that answered each call, which a server-side fallback can change, in the log and the usage', async () => {
    const { client } = stub([use('step_done', { summary: 'filled' }), use('record_verdict', { verdict: 'pass', observation: 'shown', evidence_refs: ['c2e2'] })], ['claude-opus-5-5', 'claude-sonnet-5-5']);
    const log: PayloadEntry[] = [];
    const agent = new AnthropicAgent({ client, log: (e) => log.push(e) });
    const p = plan("Type x into 'Name'");
    const c = contexts(p, NO_SCRUB, ['Name', 'Signed in']);
    await agent.act(c.act);
    await agent.judge(c.judge);
    // One request entry per call, with the model asked; the answering model is in usage.byModel.
    expect(log.map((e) => e.model)).toEqual(['claude-opus-5-5', 'claude-opus-5-5']);
    expect(agent.usage.byModel).toEqual({ 'claude-opus-5-5': { calls: 1, inputTokens: 1, outputTokens: 1 }, 'claude-sonnet-5-5': { calls: 1, inputTokens: 1, outputTokens: 1 } });
    const report = buildReport({ runId: 'r', startedAt: new Date(), finishedAt: new Date(), url: 'http://127.0.0.1:4173/', dryRun: false, model: agent.info, usage: agent.usage, method: testMethod(), plans: [] });
    expect(schemaErrors('report', report)).toEqual([]);
    expect(renderMarkdown(report)).toContain('answered by claude-opus-5-5 1, claude-sonnet-5-5 1');
  });

  it('logs the request before it leaves: the entry is there when the call throws or never returns', async () => {
    const p = plan("Type x into 'Name'");
    const c = contexts(p, NO_SCRUB, ['Name', 'Signed in']);
    const throws = { beta: { messages: { create: async () => Promise.reject(new Error('socket hang up')) } } } as unknown as Anthropic;
    const log: PayloadEntry[] = [];
    await expect(new AnthropicAgent({ client: throws, log: (e) => log.push(e) }).act(c.act)).rejects.toThrow(AgentError);
    expect(log).toHaveLength(1);
    const hangs = { beta: { messages: { create: () => new Promise(() => {}) } } } as unknown as Anthropic;
    const pending: PayloadEntry[] = [];
    void new AnthropicAgent({ client: hangs, log: (e) => pending.push(e) }).act(c.act);
    await new Promise((r) => setTimeout(r, 20));
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ kind: 'act', planId: 'login', stepId: 's1' });
  });

  // Through the runner, the refusal ends the run as an error (exit 3): test/e2e/runner.test.ts.
  it('refuses a call whose text still matches a rule (a rule gap), naming the rule, never the text', async () => {
    const { s, client } = stub([use('step_done', { summary: 'done' })]);
    const log: PayloadEntry[] = [];
    const agent = new AnthropicAgent({ client, log: (e) => log.push(e) });
    const rules = parseScrubRules({ terms: [{ from: 'Wasl', to: 'App' }, { from: 'Qasd Labs', to: 'Example Org' }] });
    const p = plan("Open the Qasd Labs settings");
    // The gap: this step's text reached the agent unscrubbed.
    const c = contexts(p, rules, ['Name', 'Signed in']);
    const err = await agent.act({ ...c.act, scrub: (t: string) => t }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentError);
    expect((err as Error).message).toContain('rule 2 (to "Example Org")');
    expect((err as Error).message).not.toMatch(/qasd/i);
    expect(s.calls).toBe(0);
    expect(log).toHaveLength(0);
  });

  it('re-scans and logs the tool results of a turn that go out as plain strings (all but the last)', async () => {
    const rules = parseScrubRules({ terms: [{ from: 'Qasd Labs', to: 'Example Org' }] });
    const p = plan("Type x into 'Name'");
    const run = async (scrub: (t: string) => string) => {
      const { s, client } = stub([[...use('fill', { ref: 'c1e1', text: 'x' }), ...use('click', { ref: 'c1e2' })], use('step_done', { summary: 'done' })]);
      const log: PayloadEntry[] = [];
      const agent = new AnthropicAgent({ client, log: (e) => log.push(e) });
      // Only the first tool's message carries the term; the last result (text and capture) is clean.
      const messages = ['filled c1e1 for Qasd Labs', 'clicked c1e2'];
      const execute = async () => ({ ok: true, message: messages.shift()!, observation: obs(2, ['Name', 'Signed in']) });
      const outcome = await agent.act({ ...contexts(p, rules, ['Name', 'Signed in']).act, scrub, execute }).catch((e: unknown) => e);
      return { s, log, outcome };
    };
    // The gap: tool messages reach the agent unscrubbed.
    const gap = await run((t) => t);
    expect(gap.outcome).toBeInstanceOf(AgentError);
    expect((gap.outcome as Error).message).toContain('rule 1 (to "Example Org")');
    expect(gap.s.calls).toBe(1);
    expect(gap.log).toHaveLength(1);
    const clean = await run((t) => scrubText(t, rules));
    expect(clean.outcome).toEqual({ status: 'done', summary: 'done' });
    expect(clean.s.calls).toBe(2);
    expect(clean.log).toHaveLength(2);
    expect(clean.log[1]!.text).toContain('filled c1e1 for Example Org');
  });

  it('keeps a secret sentinel out of payloads.jsonl and the reports, even when the app echoes it', async () => {
    const sentinel = 'SNTL-4f9c2e71-miqyas';
    const env = { MIQYAS_SECRET_PASSWORD: sentinel };
    const p = plan("Type ${secret.PASSWORD} into 'Password'");
    const rules = withSecrets(NO_SCRUB, p.steps.flatMap((st) => secretNames(st.text)), env);
    const { client } = stub([use('fill', { ref: 'c1e1', text: '${secret.PASSWORD}' }), say('Filled.'), use('step_done', { summary: 'typed the password' }), use('record_verdict', { verdict: 'pass', observation: 'Signed in is shown', evidence_refs: ['c2e2'] })]);
    const dir = await mkdtemp(path.join(os.tmpdir(), 'miqyas-sentinel-'));
    try {
      const payloads = path.join(dir, 'payloads.jsonl');
      const agent = new AnthropicAgent({ client, log: (e) => appendFileSync(payloads, JSON.stringify(e) + '\n', 'utf8') });
      const c = contexts(p, rules, ['Password', `Signed in as ${sentinel}`], `filled c1e1 with ${sentinel}`);
      const acted = await agent.act(c.act);
      const judged = await agent.judge(c.judge);
      const l = new PlanLedger(p);
      l.recordAction({ stepId: 's1', status: acted.status, summary: acted.summary, actions: [{ tool: 'fill', input: { ref: 'c1e1', text: '${secret.PASSWORD}' }, ok: true }] });
      l.recordAssertion({ stepId: 'a1', verdict: judged.verdict === 'pass' ? 'pass' : 'fail', method: 'ai', observation: judged.verdict === 'none' ? '' : judged.observation });
      const report = buildReport({ runId: 'r1', startedAt: new Date(), finishedAt: new Date(), url: 'http://127.0.0.1:4173/', dryRun: false, model: agent.info, usage: agent.usage, method: testMethod(), plans: [l.close(1)] });
      await writeFile(path.join(dir, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
      await writeFile(path.join(dir, 'report.md'), renderMarkdown(report), 'utf8');

      const lines = (await readFile(payloads, 'utf8')).trim().split('\n');
      expect(lines).toHaveLength(4);
      expect(lines.join('\n')).toContain('${secret.PASSWORD}');
      for (const f of await readdir(dir)) expect((await readFile(path.join(dir, f))).includes(sentinel), f).toBe(false);
      expect(renderMarkdown(report)).toContain('not redacted; only the served build was scrubbed');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
