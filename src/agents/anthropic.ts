// SPDX-License-Identifier: PolyForm-Shield-1.0.0
// Anthropic provider. The key comes from the environment (ANTHROPIC_API_KEY or an `ant auth login` profile, as the
// SDK resolves it); it is never read, printed or stored by Miqyas. Every text sent is scrubbed first; every call
// passes gateCall (re-scan, then one payload log entry) just before it is sent.

import Anthropic from '@anthropic-ai/sdk';
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
import {
  DEFAULT_EFFORT,
  DEFAULT_TIER,
  resolveEndpoint,
  resolveModelChoice,
  sanitizeEndpointUrl,
  type EffortLevel,
  type Tier,
} from './models.js';
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
import { DEFAULT_MAX_ACT_TURNS as SPEND_MAX_ACT_TURNS, DEFAULT_MAX_TOKENS as SPEND_MAX_TOKENS, type SpendGuard } from './spend.js';

type Msg = Anthropic.Beta.Messages.BetaMessageParam;
type Block = Anthropic.Beta.Messages.BetaContentBlockParam;
type ToolDef = Anthropic.Beta.Messages.BetaTool;

export const DEFAULT_MODEL = resolveModelChoice({ tier: DEFAULT_TIER }).model;
export { DEFAULT_EFFORT } from './models.js';
export const MAX_TOKENS = SPEND_MAX_TOKENS;
/** Model turns allowed for one action step. */
export const DEFAULT_MAX_ACT_TURNS = SPEND_MAX_ACT_TURNS;

export interface AnthropicAgentOptions {
  tier?: Tier;
  model?: string;
  endpoint?: string;
  effort?: EffortLevel;
  maxActTurns?: number;
  log?: (e: PayloadEntry) => void;
  client?: Anthropic;
  spend?: SpendGuard;
  env?: NodeJS.ProcessEnv;
}

const toAnthropicTools = (specs: readonly ToolSpec[]): ToolDef[] =>
  specs.map((s) => ({
    name: s.name,
    description: s.description,
    input_schema: s.input_schema as ToolDef['input_schema'],
    strict: true,
  }));

function imageBlock(o: Observation): Anthropic.Beta.Messages.BetaImageBlockParam {
  return { type: 'image', source: { type: 'base64', media_type: 'image/png', data: croppedPngBase64(o).base64 } };
}

function captureBlocks(label: string, o: Observation, scrub: (s: string) => string, candidates?: readonly SnapNode[]): Block[] {
  return [{ type: 'text', text: captureText(label, o, scrub, candidates) }, imageBlock(o)];
}

export class AnthropicAgent implements Agent {
  readonly info: ModelInfo;
  readonly usage: Usage = { calls: 0, inputTokens: 0, outputTokens: 0 };
  readonly limits: { maxTokens: number; maxTurns: number };
  private readonly client: Anthropic;
  private readonly maxActTurns: number;

  constructor(private readonly opts: AnthropicAgentOptions = {}) {
    const chosen = resolveModelChoice({
      ...(opts.tier !== undefined ? { tier: opts.tier } : {}),
      ...(opts.model !== undefined ? { model: opts.model } : {}),
    });
    const ep = opts.endpoint ? sanitizeEndpointUrl(opts.endpoint) : resolveEndpoint(opts.env);
    this.client = opts.client ?? new Anthropic(opts.endpoint ? { baseURL: ep.endpoint } : undefined);
    this.info = {
      provider: 'anthropic',
      model: chosen.model,
      effort: opts.effort ?? DEFAULT_EFFORT,
      ...(chosen.tier ? { tier: chosen.tier } : {}),
      endpoint: ep.endpoint,
      endpointHost: ep.host,
    };
    this.maxActTurns = opts.maxActTurns ?? DEFAULT_MAX_ACT_TURNS;
    this.limits = { maxTokens: MAX_TOKENS, maxTurns: this.maxActTurns };
  }

  /** Text and images of the newest message; tool results are opened up. Image data is counted, never scanned. */
  private outgoing(blocks: Block[]): Outgoing {
    const out: Outgoing = { text: '', images: 0, imageBytes: 0 };
    const visit = (b: unknown) => {
      if (!b || typeof b !== 'object') return;
      const blk = b as { type?: string; text?: string; source?: { data?: string }; content?: unknown; input?: unknown };
      if (blk.type === 'text' && blk.text) out.text += blk.text + '\n';
      if (blk.type === 'tool_use' && blk.input !== undefined) out.text += JSON.stringify(blk.input) + '\n';
      if (blk.type === 'image') {
        out.images++;
        out.imageBytes += Math.floor(((blk.source?.data?.length ?? 0) * 3) / 4);
      }
      if (blk.type === 'tool_result' && typeof blk.content === 'string') out.text += blk.content + '\n';
      if (blk.type === 'tool_result' && Array.isArray(blk.content)) blk.content.forEach(visit);
    };
    blocks.forEach(visit);
    return out;
  }

  private async call(kind: CallGate['kind'], ctx: CallGate['ctx'], system: string, tools: ToolDef[], messages: Msg[]): Promise<Anthropic.Beta.Messages.BetaMessage> {
    const newest = this.outgoing(messages[messages.length - 1]!.content as Block[]);
    let promptChars = system.length;
    let promptImages = 0;
    for (const m of messages) {
      const blocks = Array.isArray(m.content) ? (m.content as Block[]) : [{ type: 'text', text: String(m.content ?? '') } as Block];
      const o = this.outgoing(blocks);
      promptChars += o.text.length;
      promptImages += o.images;
    }
    const bucket = kind === 'propose' ? 'findings' : 'assert';
    // Re-scan, pessimistic spend check, and payload log BEFORE sending. Server-side fallback is disabled.
    gateCall(
      {
        kind,
        ctx,
        info: this.info,
        log: this.opts.log,
        spend: this.opts.spend,
        bucket,
        maxTokens: MAX_TOKENS,
        promptChars,
        promptImages,
      },
      newest,
    );
    const params = {
      model: this.info.model,
      max_tokens: MAX_TOKENS,
      system,
      tools,
      messages,
      output_config: { effort: this.info.effort },
    } as unknown as Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;
    let res: Anthropic.Beta.Messages.BetaMessage;
    try {
      res = await this.client.beta.messages.create(params, ctx.signal ? { signal: ctx.signal } : {});
    } catch (e) {
      if (e instanceof Anthropic.AuthenticationError) throw new AgentError('the Anthropic API rejected the credentials');
      if (e instanceof Anthropic.RateLimitError) throw new AgentError('rate limited by the Anthropic API');
      if (e instanceof Anthropic.APIError) throw new AgentError(`Anthropic API error ${e.status ?? ''}: ${e.message}`);
      throw new AgentError(`model call failed: ${(e as Error).message}`);
    }
    if (
      !res.usage ||
      typeof res.usage.input_tokens !== 'number' ||
      typeof res.usage.output_tokens !== 'number'
    ) {
      throw new AgentError('missing usage from model response');
    }
    const model = res.model ?? this.info.model;
    const input = res.usage.input_tokens + (res.usage.cache_read_input_tokens ?? 0) + (res.usage.cache_creation_input_tokens ?? 0);
    await recordAgentUsage({
      usage: this.usage,
      model,
      inputTokens: input,
      outputTokens: res.usage.output_tokens,
      spend: this.opts.spend,
      bucket,
    });
    if (res.stop_reason === 'refusal') throw new AgentError('the model declined the request');
    if (res.stop_reason === 'max_tokens') throw new AgentError('the model reply hit max_tokens');
    return res;
  }

  async act(ctx: ActContext): Promise<ActOutcome> {
    let latestObs = ctx.observation;
    let candidates = selectActCandidates(latestObs, ctx.step);
    const first: Block[] = [
      { type: 'text', text: actInitialText(ctx) },
      ...captureBlocks('Latest capture:', latestObs, ctx.scrub, candidates),
    ];
    const messages: Msg[] = [{ role: 'user', content: first }];
    let nudged = false;
    for (let turn = 0; turn < this.maxActTurns; turn++) {
      const candidateRefs = candidates.map((n) => n.ref);
      const candidateRefSet = new Set(candidateRefs);
      const tools = toAnthropicTools(buildActToolSpecs(candidateRefs));
      const res = await this.call('act', ctx, ACT_SYSTEM, tools, messages);
      messages.push({ role: 'assistant', content: res.content as Block[] });
      const uses = res.content.filter((b): b is Anthropic.Beta.Messages.BetaToolUseBlock => b.type === 'tool_use');
      if (uses.length === 0) {
        if (nudged) return { status: 'failed', summary: 'the executor stopped without calling step_done or step_failed' };
        nudged = true;
        const nudge: Block[] = [{ type: 'text', text: 'Call a tool: act, or step_done / step_failed.' }];
        messages.push({ role: 'user', content: nudge });
        continue;
      }
      const results: Block[] = [];
      for (const [i, u] of uses.entries()) {
        const input = u.input as Record<string, unknown>;
        if (u.name === 'step_done') return { status: 'done', summary: String(input.summary ?? '') };
        if (u.name === 'step_failed') return { status: 'failed', summary: String(input.reason ?? '') };
        const action = toAction(u.name, input);
        const isLast = i === uses.length - 1;
        if (!action) {
          results.push({ type: 'tool_result', tool_use_id: u.id, is_error: true, content: `unknown tool ${u.name}` });
          continue;
        }
        if (!isCandidateAction(action, candidateRefSet)) {
          const msg = nonCandidateRefMessage(action);
          results.push({
            type: 'tool_result',
            tool_use_id: u.id,
            is_error: true,
            content: isLast ? [{ type: 'text', text: ctx.scrub(msg) }, ...captureBlocks('Capture after this action:', latestObs, ctx.scrub, candidates)] : ctx.scrub(msg),
          } as Block);
          continue;
        }
        const r = await ctx.execute(action);
        latestObs = r.observation;
        candidates = selectActCandidates(latestObs, ctx.step);
        candidateRefSet.clear();
        for (const n of candidates) candidateRefSet.add(n.ref);
        results.push({
          type: 'tool_result',
          tool_use_id: u.id,
          is_error: !r.ok,
          content: isLast ? [{ type: 'text', text: ctx.scrub(r.message) }, ...captureBlocks('Capture after this action:', latestObs, ctx.scrub, candidates)] : ctx.scrub(r.message),
        } as Block);
      }
      messages.push({ role: 'user', content: results });
    }
    return { status: 'failed', summary: `the step was not done after ${this.maxActTurns} model turns` };
  }

  async judge(ctx: JudgeContext): Promise<JudgeOutcome> {
    const blocks: Block[] = [{ type: 'text', text: judgeInitialText(ctx) }];
    const shownRefs = new Set<string>();
    const addJudgeCapture = (label: string, obs: Observation) => {
      const candidates = selectJudgeCandidates(obs, ctx.step);
      for (const n of candidates) shownRefs.add(n.ref);
      return captureBlocks(label, obs, ctx.scrub, candidates);
    };
    if (ctx.postAction && ctx.postAction.capture !== ctx.current.capture) {
      const ago = ((ctx.current.capturedAt.getTime() - ctx.postAction.capturedAt.getTime()) / 1000).toFixed(1);
      blocks.push(...addJudgeCapture(`Capture ${ctx.postAction.capture}, taken right after the previous action (${ago} s before the current one):`, ctx.postAction));
    }
    blocks.push(...addJudgeCapture(`Capture ${ctx.current.capture}, current state:`, ctx.current));
    const messages: Msg[] = [{ role: 'user', content: blocks }];
    let looks = 0;
    let nudged = false;
    for (let turn = 0; turn < 5; turn++) {
      const tools = toAnthropicTools(buildJudgeToolSpecs([...shownRefs]));
      const res = await this.call('judge', ctx, JUDGE_SYSTEM, tools, messages);
      messages.push({ role: 'assistant', content: res.content as Block[] });
      const uses = res.content.filter((b): b is Anthropic.Beta.Messages.BetaToolUseBlock => b.type === 'tool_use');
      const verdict = uses.find((u) => u.name === 'record_verdict');
      if (verdict) return restrictJudgeEvidence(parseVerdictInput(verdict.input), shownRefs);
      if (uses.length === 0) {
        if (nudged) return { verdict: 'none', reason: 'the judge did not record a verdict' };
        nudged = true;
        messages.push({ role: 'user', content: [{ type: 'text', text: 'Call record_verdict now.' }] });
        continue;
      }
      const results: Block[] = [];
      for (const u of uses) {
        if (u.name !== 'look_again' || looks >= 2) {
          results.push({ type: 'tool_result', tool_use_id: u.id, is_error: true, content: u.name === 'look_again' ? 'no more looks; record the verdict' : `unknown tool ${u.name}` });
          continue;
        }
        looks++;
        const secs = parseLookAgainSeconds(u.input);
        const o = await ctx.lookAgain(secs);
        results.push({ type: 'tool_result', tool_use_id: u.id, content: addJudgeCapture(`Capture ${o.capture}, after ${secs} s:`, o) } as Block);
      }
      messages.push({ role: 'user', content: results });
    }
    return { verdict: 'none', reason: 'the judge did not record a verdict' };
  }

  /** Inspect one screen capture with a single bounded call under the 25% findings budget bucket (FR-B10). */
  async proposeFindings(ctx: ProposeFindingsContext): Promise<ProposedFinding[]> {
    const shownRefs = new Set(ctx.observation.nodes.map((n) => n.ref));
    const tools = toAnthropicTools(buildProposeToolSpecs([...shownRefs]));
    const messages: Msg[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: proposeInitialText(ctx) },
          ...captureBlocks(`Capture ${ctx.observation.capture}, screen under review:`, ctx.observation, ctx.scrub, ctx.observation.nodes),
        ],
      },
    ];
    const res = await this.call('propose', ctx, PROPOSE_SYSTEM, tools, messages);
    const uses = res.content.filter((b): b is Anthropic.Beta.Messages.BetaToolUseBlock => b.type === 'tool_use');
    const call = uses.find((u) => u.name === 'propose_findings');
    if (!call) return [];
    return parseProposedFindings(call.input, ctx.observation, shownRefs, ctx.scrub);
  }
}
