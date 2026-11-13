// SPDX-License-Identifier: PolyForm-Shield-1.0.0
// The agent interface: a provider carries out action steps (act) and judges assertions (judge). Providers are
// pluggable; Anthropic is the default. The runner owns the browser; agents only see observations and call tools.

import type { ActTool, Check, Observation } from '../surfaces/session.js';
import { AgentError, type Tier } from './models.js';
import type { SpendBucket, SpendGuard } from './spend.js';

export type { ActTool } from '../surfaces/session.js';
export { AgentError } from './models.js';

export interface ReplayInfo {
  cassette: string;
  cassetteSha256: string;
  hits: number;
  misses: number;
  imageMismatches: number;
}

export interface ModelInfo {
  provider: string;
  model: string;
  effort?: string;
  tier?: Tier;
  endpoint?: string;
  endpointHost?: string;
  replay?: ReplayInfo;
}

export interface Usage {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  /** By the model that answered (`res.model`): a server-side fallback can answer on another model than the one asked. */
  byModel?: Record<string, Omit<Usage, 'byModel'>>;
}

export interface AgentStep {
  id: string;
  type: 'action' | 'assertion';
  text: string;
  check?: Check;
}

export interface ToolExecution {
  ok: boolean;
  message: string;
  /** Observation taken right after the tool ran (settled). */
  observation: Observation;
}

export interface StepHistory {
  stepId: string;
  type: AgentStep['type'];
  text: string;
  result: string;
}

export interface ActContext {
  plan: { id: string; name: string };
  step: AgentStep;
  history: StepHistory[];
  observation: Observation;
  /** Apply scrub rules to any text before it leaves the machine. */
  scrub(text: string): string;
  /** Re-scan text about to leave the machine: the rules that still match it (must be none). */
  rescan(text: string): string[];
  /** Aborted when the plan times out: a model call still in flight is cancelled, not left to finish and bill. */
  signal?: AbortSignal;
  execute(action: ActTool): Promise<ToolExecution>;
}

export interface ActOutcome {
  status: 'done' | 'failed';
  summary: string;
}

export interface JudgeContext {
  plan: { id: string; name: string };
  step: AgentStep;
  history: StepHistory[];
  /** Captured right after the previous action's last tool, when the previous step was an action. */
  postAction?: Observation;
  current: Observation;
  scrub(text: string): string;
  rescan(text: string): string[];
  signal?: AbortSignal;
  /** Wait (at most 5 s) and observe again. No page interaction. */
  lookAgain(seconds: number): Promise<Observation>;
}

export type JudgeOutcome =
  | { verdict: 'pass' | 'fail'; observation: string; evidenceRefs: string[] }
  | { verdict: 'none'; reason: string };

export interface Agent {
  readonly info: ModelInfo | null;
  readonly usage: Usage;
  readonly limits?: { maxTokens: number; maxTurns: number };
  act(ctx: ActContext): Promise<ActOutcome>;
  judge(ctx: JudgeContext): Promise<JudgeOutcome>;
}

/** One line of payloads.jsonl: what one model call sent. */
export interface PayloadEntry {
  at: string;
  kind: 'act' | 'judge';
  planId: string;
  stepId: string;
  provider: string;
  /** The model asked; the one that answered is in the report's usage.byModel. */
  model: string;
  textChars: number;
  /** Screenshots go out with typed secrets masked on the page, the rest as captured; only the served build was scrubbed. */
  images: { count: number; scrubbed: false };
  imageBytes: number;
  /** The scrubbed text content of the newest message (the full history was logged by earlier entries). */
  text: string;
}

/** The newest message of a model call, flattened by the provider: its text and its images. */
export interface Outgoing {
  text: string;
  images: number;
  imageBytes: number;
}

export interface CallGate {
  kind: 'act' | 'judge';
  ctx: Pick<ActContext, 'plan' | 'step' | 'rescan' | 'signal'>;
  info: ModelInfo;
  log?: ((e: PayloadEntry) => void) | undefined;
  spend?: SpendGuard | undefined;
  bucket?: SpendBucket | undefined;
  maxTokens?: number | undefined;
  promptChars?: number | undefined;
  promptImages?: number | undefined;
}

/**
 * Every model call passes here first, whatever the provider: the outgoing text is re-scanned with the active rules
 * (any hit refuses the call, naming the rule, never the text), pessimistic spend guard checks run pre-call, and
 * then the call is logged. One entry per call.
 */
export function gateCall(g: CallGate, out: Outgoing): void {
  const hits = g.ctx.rescan(out.text);
  if (hits.length) throw new AgentError(`refused a model call: scrub ${hits.join(', ')} still matched the outgoing text`);
  g.spend?.beforeCall({
    model: g.info.model,
    bucket: g.bucket ?? 'assert',
    inputChars: g.promptChars ?? out.text.length,
    images: g.promptImages ?? out.images,
    maxOutputTokens: g.maxTokens ?? 16000,
  });
  g.log?.({
    at: new Date().toISOString(),
    kind: g.kind,
    planId: g.ctx.plan.id,
    stepId: g.ctx.step.id,
    provider: g.info.provider,
    model: g.info.model,
    textChars: out.text.length,
    images: { count: out.images, scrubbed: false },
    imageBytes: out.imageBytes,
    text: out.text,
  });
}
