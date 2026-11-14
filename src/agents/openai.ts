// SPDX-License-Identifier: AGPL-3.0-only
// OpenAI-compatible chat-with-images provider (Ollama, vLLM, OpenAI-compatible endpoints) behind the Agent seam.
// Re-scans scrubbed payloads, checks spend, and logs to payloads.jsonl via gateCall BEFORE any HTTP request leaves.

import type { Observation, SnapNode } from '../surfaces/session.js';
import {
  AgentError,
  gateCall,
  type ActContext,
  type ActOutcome,
  type Agent,
  type CallGate,
  type JudgeContext,
  type JudgeOutcome,
  type ModelInfo,
  type Outgoing,
  type PayloadEntry,
  type ProposeFindingsContext,
  type ProposedFinding,
  type Usage,
} from './agent.js';
import { sanitizeEndpointUrl } from './models.js';
import {
  ACT_SYSTEM,
  JUDGE_SYSTEM,
  PROPOSE_SYSTEM,
  actInitialText,
  buildActToolSpecs,
  buildJudgeToolSpecs,
  buildProposeToolSpecs,
  captureText,
  croppedPngBase64,
  isCandidateAction,
  isPlainObject,
  judgeInitialText,
  nonCandidateRefMessage,
  parseLookAgainSeconds,
  parseProposedFindings,
  parseVerdictInput,
  proposeInitialText,
  recordAgentUsage,
  restrictJudgeEvidence,
  selectActCandidates,
  selectJudgeCandidates,
  toAction,
  type ToolSpec,
} from './protocol.js';
import { DEFAULT_MAX_ACT_TURNS, DEFAULT_MAX_TOKENS, type SpendGuard } from './spend.js';

export interface OpenAIAgentOptions {
  model: string;
  endpoint: string;
  apiKey?: string;
  maxActTurns?: number;
  log?: (e: PayloadEntry) => void;
  spend?: SpendGuard;
  fetchImpl?: typeof fetch;
}

type TextPart = { type: 'text'; text: string };
type ImagePart = { type: 'image_url'; image_url: { url: string } };
type ContentPart = TextPart | ImagePart;

interface ChatToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | ContentPart[] }
  | { role: 'assistant'; content: string | null; tool_calls?: ChatToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

interface OpenAITool {
  type: 'function';
  function: { name: string; description: string; parameters: ToolSpec['input_schema'] };
}

interface ChatCompletionResponse {
  model?: string;
  choices?: Array<{
    finish_reason?: string | null;
    message?: {
      role?: string;
      content?: string | null;
      tool_calls?: Array<{ id?: string; type?: string; function?: { name?: string; arguments?: string } }>;
    };
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

const toOpenAITools = (specs: readonly ToolSpec[]): OpenAITool[] =>
  specs.map((s) => ({
    type: 'function',
    function: { name: s.name, description: s.description, parameters: s.input_schema },
  }));

export function chatCompletionsUrl(baseEndpoint: string): string {
  const clean = sanitizeEndpointUrl(baseEndpoint);
  const u = new URL(clean.endpoint);
  const p = u.pathname.endsWith('/') ? u.pathname.slice(0, -1) : u.pathname;
  if (p.endsWith('/chat/completions')) u.pathname = p;
  else if (p.endsWith('/v1')) u.pathname = `${p}/chat/completions`;
  else u.pathname = `${p}/v1/chat/completions`;
  return u.href;
}

function captureParts(label: string, o: Observation, scrub: (s: string) => string, candidates?: readonly SnapNode[]): ContentPart[] {
  const { base64 } = croppedPngBase64(o);
  return [
    { type: 'text', text: captureText(label, o, scrub, candidates) },
    { type: 'image_url', image_url: { url: `data:image/png;base64,${base64}` } },
  ];
}

function measureMessages(msgs: ChatMessage[]): Outgoing {
  const out: Outgoing = { text: '', images: 0, imageBytes: 0 };
  for (const m of msgs) {
    if (m.role === 'assistant') {
      if (m.content) out.text += m.content + '\n';
      if (m.tool_calls) {
        for (const tc of m.tool_calls) out.text += `${tc.function.name} ${tc.function.arguments}\n`;
      }
      continue;
    }
    if (typeof m.content === 'string') {
      out.text += m.content + '\n';
      continue;
    }
    for (const part of m.content) {
      if (part.type === 'text') {
        out.text += part.text + '\n';
      } else {
        out.images++;
        const comma = part.image_url.url.indexOf(',');
        const b64Len = comma >= 0 ? part.image_url.url.length - comma - 1 : part.image_url.url.length;
        out.imageBytes += Math.floor((b64Len * 3) / 4);
      }
    }
  }
  return out;
}

export class OpenAIAgent implements Agent {
  readonly info: ModelInfo;
  readonly usage: Usage = { calls: 0, inputTokens: 0, outputTokens: 0 };
  readonly limits: { maxTokens: number; maxTurns: number };
  private readonly requestUrl: string;
  private readonly maxActTurns: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: OpenAIAgentOptions) {
    const clean = sanitizeEndpointUrl(opts.endpoint);
    this.requestUrl = chatCompletionsUrl(clean.endpoint);
    this.info = {
      provider: 'openai',
      model: opts.model,
      endpoint: clean.endpoint,
      endpointHost: clean.host,
    };
    this.maxActTurns = opts.maxActTurns ?? DEFAULT_MAX_ACT_TURNS;
    this.limits = { maxTokens: DEFAULT_MAX_TOKENS, maxTurns: this.maxActTurns };
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async call(
    kind: CallGate['kind'],
    ctx: CallGate['ctx'],
    tools: OpenAITool[],
    messages: ChatMessage[],
    newestMessages: ChatMessage[],
  ): Promise<{ content: string | null; toolCalls: ChatToolCall[] }> {
    const newest = measureMessages(newestMessages);
    const total = measureMessages(messages);
    const bucket = kind === 'propose' ? 'findings' : 'assert';
    gateCall(
      {
        kind,
        ctx,
        info: this.info,
        log: this.opts.log,
        spend: this.opts.spend,
        bucket,
        maxTokens: DEFAULT_MAX_TOKENS,
        promptChars: total.text.length,
        promptImages: total.images,
      },
      newest,
    );

    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.opts.apiKey) headers.authorization = `Bearer ${this.opts.apiKey}`;

    const body = JSON.stringify({
      model: this.info.model,
      max_tokens: DEFAULT_MAX_TOKENS,
      n: 1,
      messages,
      tools,
      tool_choice: 'auto',
    });

    let res: Response;
    try {
      res = await this.fetchImpl(this.requestUrl, {
        method: 'POST',
        headers,
        body,
        redirect: 'error',
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
    } catch (e) {
      throw new AgentError(`model call failed: ${(e as Error).message}`);
    }

    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 200);
      if (res.status === 401 || res.status === 403) {
        throw new AgentError('the OpenAI-compatible API rejected the credentials');
      }
      if (res.status === 429) {
        throw new AgentError('rate limited by the OpenAI-compatible API');
      }
      throw new AgentError(`OpenAI-compatible API error ${res.status}: ${detail || res.statusText}`);
    }

    let data: ChatCompletionResponse;
    try {
      data = (await res.json()) as ChatCompletionResponse;
    } catch {
      throw new AgentError('invalid JSON response from OpenAI-compatible model');
    }

    const choice = data.choices?.[0];
    if (!choice?.message) throw new AgentError('invalid response from OpenAI-compatible model');
    if (
      !data.usage ||
      typeof data.usage.prompt_tokens !== 'number' ||
      typeof data.usage.completion_tokens !== 'number'
    ) {
      throw new AgentError('missing usage from model response');
    }

    const answeredModel = data.model || this.info.model;
    await recordAgentUsage({
      usage: this.usage,
      model: answeredModel,
      inputTokens: data.usage.prompt_tokens,
      outputTokens: data.usage.completion_tokens,
      spend: this.opts.spend,
      bucket,
    });

    if (choice.finish_reason === 'content_filter') throw new AgentError('the model declined the request');
    if (choice.finish_reason === 'length') throw new AgentError('the model reply hit max_tokens');

    const rawCalls = Array.isArray(choice.message.tool_calls) ? choice.message.tool_calls : [];
    const toolCalls: ChatToolCall[] = rawCalls.map((tc, idx) => ({
      id: tc.id || `tc_${idx}`,
      type: 'function',
      function: {
        name: String(tc.function?.name ?? ''),
        arguments: String(tc.function?.arguments ?? '{}'),
      },
    }));
    return { content: choice.message.content ?? null, toolCalls };
  }

  async act(ctx: ActContext): Promise<ActOutcome> {
    let latestObs = ctx.observation;
    let candidates = selectActCandidates(latestObs, ctx.step);
    const firstUser: ChatMessage = {
      role: 'user',
      content: [{ type: 'text', text: actInitialText(ctx) }, ...captureParts('Latest capture:', latestObs, ctx.scrub, candidates)],
    };
    const messages: ChatMessage[] = [{ role: 'system', content: ACT_SYSTEM }, firstUser];
    let pendingNewest: ChatMessage[] = [firstUser];
    let nudged = false;

    for (let turn = 0; turn < this.maxActTurns; turn++) {
      const candidateRefs = candidates.map((n) => n.ref);
      const candidateRefSet = new Set(candidateRefs);
      const tools = toOpenAITools(buildActToolSpecs(candidateRefs));
      const reply = await this.call('act', ctx, tools, messages, pendingNewest);
      messages.push({
        role: 'assistant',
        content: reply.content ?? (reply.toolCalls.length ? null : ''),
        ...(reply.toolCalls.length ? { tool_calls: reply.toolCalls } : {}),
      });

      if (reply.toolCalls.length === 0) {
        if (nudged) return { status: 'failed', summary: 'the executor stopped without calling step_done or step_failed' };
        nudged = true;
        const nudge: ChatMessage = { role: 'user', content: 'Call a tool: act, or step_done / step_failed.' };
        messages.push(nudge);
        pendingNewest = [nudge];
        continue;
      }

      const added: ChatMessage[] = [];
      let executedObs: Observation | undefined;
      for (const tc of reply.toolCalls) {
        let input: unknown;
        try {
          input = JSON.parse(tc.function.arguments || '{}');
        } catch {
          added.push({ role: 'tool', tool_call_id: tc.id, content: `invalid JSON arguments for ${tc.function.name}` });
          continue;
        }
        if (!isPlainObject(input)) {
          added.push({ role: 'tool', tool_call_id: tc.id, content: `invalid JSON arguments for ${tc.function.name}` });
          continue;
        }
        if (tc.function.name === 'step_done') return { status: 'done', summary: String(input.summary ?? '') };
        if (tc.function.name === 'step_failed') return { status: 'failed', summary: String(input.reason ?? '') };

        const action = toAction(tc.function.name, input);
        if (!action) {
          added.push({ role: 'tool', tool_call_id: tc.id, content: `unknown tool ${tc.function.name}` });
          continue;
        }
        if (!isCandidateAction(action, candidateRefSet)) {
          added.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: ctx.scrub(nonCandidateRefMessage(action)),
          });
          continue;
        }
        const r = await ctx.execute(action);
        latestObs = r.observation;
        executedObs = r.observation;
        candidates = selectActCandidates(latestObs, ctx.step);
        candidateRefSet.clear();
        for (const n of candidates) candidateRefSet.add(n.ref);
        added.push({ role: 'tool', tool_call_id: tc.id, content: ctx.scrub(r.ok ? r.message : `error: ${r.message}`) });
      }
      // OpenAI chat completions expects role:'tool' to be plain text; attach the post-action screenshot in a user message.
      if (executedObs) {
        added.push({ role: 'user', content: captureParts('Capture after this action:', executedObs, ctx.scrub, candidates) });
      }
      messages.push(...added);
      pendingNewest = added;
    }
    return { status: 'failed', summary: `the step was not done after ${this.maxActTurns} model turns` };
  }

  async judge(ctx: JudgeContext): Promise<JudgeOutcome> {
    const parts: ContentPart[] = [{ type: 'text', text: judgeInitialText(ctx) }];
    const shownRefs = new Set<string>();
    const addJudgeCapture = (label: string, obs: Observation) => {
      const candidates = selectJudgeCandidates(obs, ctx.step);
      for (const n of candidates) shownRefs.add(n.ref);
      return captureParts(label, obs, ctx.scrub, candidates);
    };
    if (ctx.postAction && ctx.postAction.capture !== ctx.current.capture) {
      const ago = ((ctx.current.capturedAt.getTime() - ctx.postAction.capturedAt.getTime()) / 1000).toFixed(1);
      parts.push(
        ...addJudgeCapture(
          `Capture ${ctx.postAction.capture}, taken right after the previous action (${ago} s before the current one):`,
          ctx.postAction,
        ),
      );
    }
    parts.push(...addJudgeCapture(`Capture ${ctx.current.capture}, current state:`, ctx.current));

    const firstUser: ChatMessage = { role: 'user', content: parts };
    const messages: ChatMessage[] = [{ role: 'system', content: JUDGE_SYSTEM }, firstUser];
    let pendingNewest: ChatMessage[] = [firstUser];
    let looks = 0;
    let nudged = false;

    for (let turn = 0; turn < 5; turn++) {
      const tools = toOpenAITools(buildJudgeToolSpecs([...shownRefs]));
      const reply = await this.call('judge', ctx, tools, messages, pendingNewest);
      messages.push({
        role: 'assistant',
        content: reply.content ?? (reply.toolCalls.length ? null : ''),
        ...(reply.toolCalls.length ? { tool_calls: reply.toolCalls } : {}),
      });

      const verdictCall = reply.toolCalls.find((tc) => tc.function.name === 'record_verdict');
      if (verdictCall) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(verdictCall.function.arguments || '{}');
        } catch {
          return { verdict: 'none', reason: 'record_verdict with invalid JSON arguments' };
        }
        return restrictJudgeEvidence(parseVerdictInput(parsed), shownRefs);
      }

      if (reply.toolCalls.length === 0) {
        if (nudged) return { verdict: 'none', reason: 'the judge did not record a verdict' };
        nudged = true;
        const nudge: ChatMessage = { role: 'user', content: 'Call record_verdict now.' };
        messages.push(nudge);
        pendingNewest = [nudge];
        continue;
      }

      const added: ChatMessage[] = [];
      let lastLook: { obs: Observation; secs: number } | undefined;
      for (const tc of reply.toolCalls) {
        if (tc.function.name !== 'look_again' || looks >= 2) {
          added.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: tc.function.name === 'look_again' ? 'no more looks; record the verdict' : `unknown tool ${tc.function.name}`,
          });
          continue;
        }
        looks++;
        let secs = 1;
        try {
          secs = parseLookAgainSeconds(JSON.parse(tc.function.arguments || '{}'));
        } catch {
          secs = 1;
        }
        const obs = await ctx.lookAgain(secs);
        lastLook = { obs, secs };
        added.push({ role: 'tool', tool_call_id: tc.id, content: `Observed capture ${obs.capture} after ${secs} s.` });
      }
      if (lastLook) {
        added.push({
          role: 'user',
          content: addJudgeCapture(`Capture ${lastLook.obs.capture}, after ${lastLook.secs} s:`, lastLook.obs),
        });
      }
      messages.push(...added);
      pendingNewest = added;
    }
    return { verdict: 'none', reason: 'the judge did not record a verdict' };
  }

  /** Inspect one screen capture with a single bounded call under the 25% findings budget bucket (FR-B10). */
  async proposeFindings(ctx: ProposeFindingsContext): Promise<ProposedFinding[]> {
    const shownRefs = new Set(ctx.observation.nodes.map((n) => n.ref));
    const tools = toOpenAITools(buildProposeToolSpecs([...shownRefs]));
    const userMsg: ChatMessage = {
      role: 'user',
      content: [
        { type: 'text', text: proposeInitialText(ctx) },
        ...captureParts(`Capture ${ctx.observation.capture}, screen under review:`, ctx.observation, ctx.scrub, ctx.observation.nodes),
      ],
    };
    const messages: ChatMessage[] = [{ role: 'system', content: PROPOSE_SYSTEM }, userMsg];
    const reply = await this.call('propose', ctx, tools, messages, [userMsg]);
    const call = reply.toolCalls.find((tc) => tc.function.name === 'propose_findings');
    if (!call) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(call.function.arguments || '{}');
    } catch {
      return [];
    }
    return parseProposedFindings(parsed, ctx.observation, shownRefs, ctx.scrub);
  }
}
