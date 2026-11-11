// SPDX-License-Identifier: PolyForm-Shield-1.0.0
// The agent interface: a provider carries out action steps (act) and judges assertions (judge). Providers are
// pluggable; Anthropic is the default. The runner owns the browser; agents only see observations and call tools.

import type { Step } from '../core/plan.js';
import type { ModelInfo, Usage } from '../core/report.js';
import type { Observation } from '../web/observe.js';

export type ActTool =
  | { tool: 'click'; ref: string }
  | { tool: 'fill'; ref: string; text: string }
  | { tool: 'select_option'; ref: string; option: string }
  | { tool: 'press'; key: string }
  | { tool: 'scroll'; direction: 'up' | 'down'; ref?: string }
  | { tool: 'wait'; seconds: number }
  | { tool: 'navigate'; path: string };

export interface ToolExecution {
  ok: boolean;
  message: string;
  /** Observation taken right after the tool ran (settled). */
  observation: Observation;
}

export interface StepHistory {
  stepId: string;
  type: Step['type'];
  text: string;
  result: string;
}

export interface ActContext {
  plan: { id: string; name: string };
  step: Step;
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
  step: Step;
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
  act(ctx: ActContext): Promise<ActOutcome>;
  judge(ctx: JudgeContext): Promise<JudgeOutcome>;
}

/** An error from the model provider (network, auth, refusal) or a refused payload: the plan ends as an error, never a
 * pass (exit 3). */
export class AgentError extends Error {}

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
}

/**
 * Every model call passes here first, whatever the provider: the outgoing text is re-scanned with the active rules
 * (any hit refuses the call, naming the rule, never the text), then the call is logged. One entry per call.
 */
export function gateCall(g: CallGate, out: Outgoing): void {
  const hits = g.ctx.rescan(out.text);
  if (hits.length) throw new AgentError(`refused a model call: scrub ${hits.join(', ')} still matched the outgoing text`);
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
