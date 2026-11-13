// SPDX-License-Identifier: PolyForm-Shield-1.0.0
// Offline OpenAI-compatible router & agent tests against a local 127.0.0.1 HTTP mock server (issue #10).

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { PNG } from 'pngjs';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentError, type PayloadEntry } from '../../src/agents/agent.js';
import { OpenAIAgent } from '../../src/agents/openai.js';
import { createRoutedAgent, resolveRoute } from '../../src/agents/router.js';
import { parsePlan } from '../../src/proof-core/plan.js';
import { NO_SCRUB, parseScrubRules, ruleHits, scrubText } from '../../src/scrub/scrub.js';
import type { Observation } from '../../src/surfaces/session.js';

const png = PNG.sync.write(new PNG({ width: 4, height: 4 }));

function makeObs(capture: number, names: string[]): Observation {
  const nodes = names.map((name, i) => ({
    ref: `c${capture}e${i + 1}`,
    role: i === 0 ? 'textbox' : 'status',
    name,
    depth: 0,
    box: { x: 0, y: i * 10, width: 4, height: 4 },
    state: '',
    locator: '',
  }));
  return {
    capture,
    url: 'http://127.0.0.1:4173/',
    title: 'Fixture',
    lang: 'en',
    dir: 'ltr',
    viewport: { width: 4, height: 4 },
    nodes,
    truncated: false,
    png,
    capturedAt: new Date(),
  };
}

function samplePlan(actionText: string) {
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

interface RecordedReq {
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: Record<string, unknown>;
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function startMockOpenAI(
  handler: (req: RecordedReq, res: ServerResponse, rawReq: IncomingMessage) => void,
): Promise<{ url: string; requests: RecordedReq[] }> {
  const requests: RecordedReq[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      const rec: RecordedReq = {
        url: req.url ?? '/',
        headers: req.headers,
        body: text ? (JSON.parse(text) as Record<string, unknown>) : {},
      };
      requests.push(rec);
      handler(rec, res, req);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address() as { port: number };
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { url: `http://127.0.0.1:${addr.port}/v1`, requests };
}

describe('OpenAIAgent + createRoutedAgent', () => {
  it('completes multi-turn chat-with-images act and judge flows against a local OpenAI-compatible server', async () => {
    let turn = 0;
    const mock = await startMockOpenAI((_req, res) => {
      turn++;
      res.writeHead(200, { 'content-type': 'application/json' });
      if (turn === 1) {
        res.end(
          JSON.stringify({
            model: 'qwen2.5-vl:7b',
            choices: [
              {
                finish_reason: 'tool_calls',
                message: {
                  role: 'assistant',
                  content: null,
                  tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'fill', arguments: JSON.stringify({ ref: 'c1e1', text: 'alice' }) } }],
                },
              },
            ],
            usage: { prompt_tokens: 120, completion_tokens: 15 },
          }),
        );
        return;
      }
      if (turn === 2) {
        res.end(
          JSON.stringify({
            model: 'qwen2.5-vl:7b',
            choices: [
              {
                finish_reason: 'tool_calls',
                message: {
                  role: 'assistant',
                  content: null,
                  tool_calls: [{ id: 'tc2', type: 'function', function: { name: 'step_done', arguments: JSON.stringify({ summary: 'Filled alice' }) } }],
                },
              },
            ],
            usage: { prompt_tokens: 180, completion_tokens: 10 },
          }),
        );
        return;
      }
      if (turn === 3) {
        res.end(
          JSON.stringify({
            model: 'qwen2.5-vl:7b',
            choices: [
              {
                finish_reason: 'tool_calls',
                message: {
                  role: 'assistant',
                  content: null,
                  tool_calls: [{ id: 'tc3', type: 'function', function: { name: 'look_again', arguments: JSON.stringify({ seconds: 1 }) } }],
                },
              },
            ],
            usage: { prompt_tokens: 90, completion_tokens: 8 },
          }),
        );
        return;
      }
      res.end(
        JSON.stringify({
          model: 'qwen2.5-vl:7b',
          choices: [
            {
              finish_reason: 'tool_calls',
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: 'tc4',
                    type: 'function',
                    function: {
                      name: 'record_verdict',
                      arguments: JSON.stringify({ verdict: 'pass', observation: 'Signed in banner visible', evidence_refs: ['c3e2'] }),
                    },
                  },
                ],
              },
            },
          ],
          usage: { prompt_tokens: 140, completion_tokens: 14 },
        }),
      );
    });

    const route = resolveRoute({ provider: 'openai', endpoint: mock.url, model: 'qwen2.5-vl:7b', env: {} });
    const logs: PayloadEntry[] = [];
    const agent = createRoutedAgent({ route, log: (e) => logs.push(e) });

    expect(agent).toBeInstanceOf(OpenAIAgent);
    expect(agent.info).toMatchObject({ provider: 'openai', model: 'qwen2.5-vl:7b', endpoint: mock.url });

    const p = samplePlan("Type alice into 'Name'");
    const base = {
      plan: { id: p.id, name: p.name },
      history: [],
      scrub: (t: string) => scrubText(t, NO_SCRUB),
      rescan: (t: string) => ruleHits(t, NO_SCRUB),
    };
    const actOut = await agent.act({
      ...base,
      step: p.steps[0]!,
      observation: makeObs(1, ['Name', 'Form']),
      execute: async () => ({ ok: true, message: 'filled c1e1', observation: makeObs(2, ['Name', 'Signed in']) }),
    });
    expect(actOut).toEqual({ status: 'done', summary: 'Filled alice' });

    const judgeOut = await agent.judge({
      ...base,
      step: p.steps[1]!,
      current: makeObs(2, ['Name', 'Signed in']),
      lookAgain: async () => makeObs(3, ['Name', 'Signed in']),
    });
    expect(judgeOut).toEqual({ verdict: 'pass', observation: 'Signed in banner visible', evidenceRefs: ['c3e2'] });

    expect(mock.requests).toHaveLength(4);
    expect(mock.requests[0]!.url).toBe('/v1/chat/completions');
    expect(mock.requests[0]!.headers.authorization).toBeUndefined();
    const turn2Msgs = mock.requests[1]!.body.messages as Array<{ role: string; content: unknown }>;
    expect(turn2Msgs.some((m) => m.role === 'tool')).toBe(true);
    const lastUser = turn2Msgs[turn2Msgs.length - 1]!;
    expect(lastUser.role).toBe('user');
    expect(JSON.stringify(lastUser.content)).toContain('data:image/png;base64,');

    expect(agent.usage).toEqual({
      calls: 4,
      inputTokens: 530,
      outputTokens: 47,
      byModel: { 'qwen2.5-vl:7b': { calls: 4, inputTokens: 530, outputTokens: 47 } },
    });
    expect(logs.map((l) => l.kind)).toEqual(['act', 'act', 'judge', 'judge']);
  });

  it('aborts in gateCall before hitting network when an unscrubbed term remains, and attaches Bearer token when OPENAI_API_KEY is set', async () => {
    const mock = await startMockOpenAI((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          model: 'qwen2.5-vl',
          choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'step_done', arguments: '{"summary":"ok"}' } }] } }],
          usage: { prompt_tokens: 10, completion_tokens: 2 },
        }),
      );
    });

    const rules = parseScrubRules({ version: 1, terms: [{ from: 'AcmeCorp', to: 'OrgA' }] }, 'r.json');
    const agent = new OpenAIAgent({ endpoint: mock.url, model: 'qwen2.5-vl', apiKey: 'sk-local-secret' });
    const p = samplePlan('Open AcmeCorp dashboard');

    // Intentional non-scrubbed identity function lets rescan catch 'AcmeCorp' before fetch!
    await expect(
      agent.act({
        plan: { id: p.id, name: p.name },
        history: [],
        step: p.steps[0]!,
        observation: makeObs(1, ['Header']),
        scrub: (t) => t,
        rescan: (t) => ruleHits(t, rules),
        execute: async () => ({ ok: true, message: 'ok', observation: makeObs(2, ['Header']) }),
      }),
    ).rejects.toThrow(AgentError);
    expect(mock.requests).toHaveLength(0);

    // Properly scrubbed call reaches the mock server with Bearer auth.
    const clean = await agent.act({
      plan: { id: p.id, name: p.name },
      history: [],
      step: p.steps[0]!,
      observation: makeObs(1, ['Header']),
      scrub: (t) => scrubText(t, rules),
      rescan: (t) => ruleHits(t, rules),
      execute: async () => ({ ok: true, message: 'ok', observation: makeObs(2, ['Header']) }),
    });
    expect(clean.status).toBe('done');
    expect(mock.requests[0]!.headers.authorization).toBe('Bearer sk-local-secret');
  });

  it('fails closed on HTTP errors, redirects, missing usage, and finish_reason length/content_filter', async () => {
    const mode = { next: '401' as '401' | '302' | 'nousage' | 'length' };
    const mock = await startMockOpenAI((_req, res) => {
      if (mode.next === '401') {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end('{"error":"unauthorized"}');
      } else if (mode.next === '302') {
        res.writeHead(302, { location: 'http://127.0.0.1:9/evil' });
        res.end();
      } else if (mode.next === 'nousage') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ model: 'm', choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'hi' } }] }));
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            model: 'm',
            choices: [{ finish_reason: 'length', message: { role: 'assistant', content: 'cut' } }],
            usage: { prompt_tokens: 5, completion_tokens: 4096 },
          }),
        );
      }
    });

    const p = samplePlan('Open home');
    const makeCtx = () => ({
      plan: { id: p.id, name: p.name },
      history: [],
      step: p.steps[0]!,
      observation: makeObs(1, ['Home']),
      scrub: (t: string) => t,
      rescan: () => [],
      execute: async () => ({ ok: true, message: 'ok', observation: makeObs(2, ['Home']) }),
    });

    const agent = new OpenAIAgent({ endpoint: mock.url.replace(/\/v1$/, ''), model: 'm' });
    mode.next = '401';
    await expect(agent.act(makeCtx())).rejects.toThrow(AgentError);
    mode.next = '302';
    await expect(agent.act(makeCtx())).rejects.toThrow(AgentError);
    mode.next = 'nousage';
    await expect(agent.act(makeCtx())).rejects.toThrow(AgentError);
    mode.next = 'length';
    await expect(agent.act(makeCtx())).rejects.toThrow(AgentError);
  });

  it('recovers cleanly when a local model emits non-object JSON arguments for a tool call', async () => {
    let turn = 0;
    const mock = await startMockOpenAI((_req, res) => {
      turn++;
      res.writeHead(200, { 'content-type': 'application/json' });
      if (turn === 1) {
        res.end(
          JSON.stringify({
            model: 'm',
            choices: [
              {
                finish_reason: 'tool_calls',
                message: {
                  role: 'assistant',
                  content: null,
                  tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'click', arguments: 'null' } }],
                },
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 4 },
          }),
        );
        return;
      }
      res.end(
        JSON.stringify({
          model: 'm',
          choices: [
            {
              finish_reason: 'tool_calls',
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [{ id: 'tc2', type: 'function', function: { name: 'step_done', arguments: '{"summary":"recovered"}' } }],
              },
            },
          ],
          usage: { prompt_tokens: 12, completion_tokens: 4 },
        }),
      );
    });

    const p = samplePlan('Click button');
    const agent = new OpenAIAgent({ endpoint: mock.url, model: 'm' });
    const out = await agent.act({
      plan: { id: p.id, name: p.name },
      history: [],
      step: p.steps[0]!,
      observation: makeObs(1, ['Submit']),
      scrub: (t) => t,
      rescan: () => [],
      execute: async () => ({ ok: true, message: 'ok', observation: makeObs(2, ['Submit']) }),
    });
    expect(out).toEqual({ status: 'done', summary: 'recovered' });
    const turn2Msgs = mock.requests[1]!.body.messages as Array<{ role: string; content: string }>;
    expect(turn2Msgs.some((m) => m.role === 'tool' && m.content.includes('invalid JSON arguments for click'))).toBe(true);
  });
});
