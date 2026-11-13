// SPDX-License-Identifier: PolyForm-Shield-1.0.0
// Deterministic cassette record-and-replay at the Agent seam (Layer 2: agents).
// Cassettes store normalized, scrubbed requests/responses plus image hashes/dHash (never raw PNG pixels).
// Replay matches on canonical SHA-256 + occurrence index + visual dHash and fails closed on any miss or corruption.

import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { PNG } from 'pngjs';
import type { Observation } from '../surfaces/session.js';
import { cropPng } from '../surfaces/web/observe.js';
import {
  AgentError,
  type ActContext,
  type ActOutcome,
  type ActTool,
  type Agent,
  type JudgeContext,
  type JudgeOutcome,
  type ModelInfo,
  type ReplayInfo,
  type Usage,
} from './agent.js';
import type { Tier } from './models.js';
import {
  ACT_SYSTEM,
  ACT_TOOL_SPECS,
  JUDGE_SYSTEM,
  JUDGE_TOOL_SPECS,
  actInitialText,
  captureText,
  isPlainObject,
  judgeInitialText,
} from './protocol.js';
import { DEFAULT_MAX_ACT_TURNS, DEFAULT_MAX_TOKENS } from './spend.js';

export const CASSETTE_SCHEMA = 1;
export const NORMALISER_VERSION = 1;
export const DEFAULT_MAX_DHASH_DISTANCE = 8;

const ACT_PROMPT_DIGEST = sha256Hex(JSON.stringify({ system: ACT_SYSTEM, tools: ACT_TOOL_SPECS }));
const JUDGE_PROMPT_DIGEST = sha256Hex(JSON.stringify({ system: JUDGE_SYSTEM, tools: JUDGE_TOOL_SPECS }));
const DHASH_RE = /^[0-9a-f]{16}$/i;

export class ReplayMissError extends AgentError {}

export interface ImageFingerprint {
  sha256: string;
  dHash: string;
}

export interface CassetteHeader {
  type: 'header';
  cassetteSchema: number;
  normaliserVersion: number;
  provider: string;
  model: string;
  tier: Tier | null;
  effort?: string;
  platform: string;
  createdAt: string;
}

export type CassetteResponse =
  | { type: 'execute'; action: ActTool }
  | { type: 'act_return'; outcome: ActOutcome }
  | { type: 'look_again'; seconds: number }
  | { type: 'judge_return'; outcome: JudgeOutcome };

export interface CassetteCallEntry {
  type: 'call';
  key: string;
  occurrence: number;
  kind: 'act' | 'judge';
  tier: Tier | null;
  planId: string;
  stepId: string;
  turn: number;
  requestText: string;
  images: ImageFingerprint[];
  response: CassetteResponse;
}

function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function computeDHashFromCropped(cropped: Buffer): string {
  const img = PNG.sync.read(cropped);
  const w = Math.max(1, img.width);
  const h = Math.max(1, img.height);
  const luma = (gx: number, gy: number): number => {
    const px = Math.min(w - 1, Math.floor((gx * w) / 9));
    const py = Math.min(h - 1, Math.floor((gy * h) / 8));
    const idx = (py * w + px) * 4;
    const r = img.data[idx] ?? 0;
    const g = img.data[idx + 1] ?? 0;
    const b = img.data[idx + 2] ?? 0;
    return 0.299 * r + 0.587 * g + 0.114 * b;
  };
  let bits = 0n;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      bits = (bits << 1n) | (luma(x, y) > luma(x + 1, y) ? 1n : 0n);
    }
  }
  return bits.toString(16).padStart(16, '0');
}

export function dhashDistance(a: string, b: string): number {
  let x = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  let count = 0;
  while (x > 0n) {
    count += Number(x & 1n);
    x >>= 1n;
  }
  return count;
}

export function imageFingerprint(obs: Observation): ImageFingerprint {
  const cropped = cropPng(obs.png, [{ x: 0, y: 0, width: 100000, height: 3000 }], 0) ?? obs.png;
  return { sha256: sha256Hex(cropped), dHash: computeDHashFromCropped(cropped) };
}

class RefNormalizer {
  private readonly toNorm = new Map<string, string>();
  private readonly toLive = new Map<string, string>();
  private next = 1;

  normalizeRef(ref: string): string {
    if (!/^c\d+e\d+$/.test(ref)) return ref;
    let norm = this.toNorm.get(ref);
    if (!norm) {
      norm = `r${this.next++}`;
      this.toNorm.set(ref, norm);
      this.toLive.set(norm, ref);
    }
    return norm;
  }

  denormalizeRef(ref: string): string {
    return this.toLive.get(ref) ?? ref;
  }

  normalizeText(raw: string, scrub: (s: string) => string): string {
    return scrub(raw)
      .replace(/\bc\d+e\d+\b/g, (m) => this.normalizeRef(m))
      .replace(/\b(Capture|capture) \d+\b/g, '$1 #')
      .replace(/https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d+/gi, '$ORIGIN')
      .replace(/\(\d+\.\d+ s before the current one\)/g, '(elapsed before the current one)');
  }

  denormalizeText(raw: string): string {
    return raw.replace(/\br\d+\b/g, (m) => this.toLive.get(m) ?? m);
  }

  normalizeAction(action: ActTool, scrub: (s: string) => string): ActTool {
    const clone = { ...action } as Record<string, unknown>;
    if (typeof clone.ref === 'string') clone.ref = this.normalizeRef(clone.ref);
    if (typeof clone.text === 'string') clone.text = this.normalizeText(clone.text, scrub);
    if (typeof clone.option === 'string') clone.option = this.normalizeText(clone.option, scrub);
    if (typeof clone.path === 'string') clone.path = this.normalizeText(clone.path, scrub);
    return clone as ActTool;
  }

  denormalizeAction(action: ActTool): ActTool {
    const clone = { ...action } as Record<string, unknown>;
    if (typeof clone.ref === 'string') clone.ref = this.denormalizeRef(clone.ref);
    return clone as ActTool;
  }

  normalizeActOutcome(outcome: ActOutcome, scrub: (s: string) => string): ActOutcome {
    return { status: outcome.status, summary: this.normalizeText(outcome.summary, scrub) };
  }

  denormalizeActOutcome(outcome: ActOutcome): ActOutcome {
    return { status: outcome.status, summary: this.denormalizeText(outcome.summary) };
  }

  normalizeJudgeOutcome(outcome: JudgeOutcome, scrub: (s: string) => string): JudgeOutcome {
    if (outcome.verdict === 'none') {
      return { verdict: 'none', reason: this.normalizeText(outcome.reason, scrub) };
    }
    return {
      verdict: outcome.verdict,
      observation: this.normalizeText(outcome.observation, scrub),
      evidenceRefs: outcome.evidenceRefs.map((r) => this.normalizeRef(r)),
    };
  }

  denormalizeJudgeOutcome(outcome: JudgeOutcome): JudgeOutcome {
    if (outcome.verdict === 'none') {
      return { verdict: 'none', reason: this.denormalizeText(outcome.reason) };
    }
    return {
      verdict: outcome.verdict,
      observation: this.denormalizeText(outcome.observation),
      evidenceRefs: outcome.evidenceRefs.map((r) => this.denormalizeRef(r)),
    };
  }
}

interface NormalizedTurn {
  obsTexts: string[];
  images: ImageFingerprint[];
  priorEvent?: string;
}

function assertCleanScrub(texts: string[], rescan: (s: string) => string[], action: 'persist' | 'replay'): void {
  for (const t of texts) {
    const hits = rescan(t);
    if (hits.length > 0) {
      throw new AgentError(`cassette scrub check blocked (${hits.join(', ')}): refused to ${action} unscrubbed data`);
    }
  }
}

function buildInitialActTurn(obs: Observation, scrub: (s: string) => string, norm: RefNormalizer): NormalizedTurn {
  return {
    obsTexts: [norm.normalizeText(captureText('Latest capture:', obs, scrub), scrub)],
    images: [imageFingerprint(obs)],
  };
}

function buildExecuteTurn(
  normAction: ActTool,
  result: { ok: boolean; message: string; observation: Observation },
  scrub: (s: string) => string,
  norm: RefNormalizer,
): NormalizedTurn {
  return {
    priorEvent: `execute:${JSON.stringify(normAction)}->ok=${result.ok}:${norm.normalizeText(result.message, scrub)}`,
    obsTexts: [norm.normalizeText(captureText('Capture after this action:', result.observation, scrub), scrub)],
    images: [imageFingerprint(result.observation)],
  };
}

function buildInitialJudgeTurn(ctx: JudgeContext, norm: RefNormalizer): NormalizedTurn {
  const obsTexts: string[] = [];
  const images: ImageFingerprint[] = [];
  if (ctx.postAction && ctx.postAction.capture !== ctx.current.capture) {
    const ago = ((ctx.current.capturedAt.getTime() - ctx.postAction.capturedAt.getTime()) / 1000).toFixed(1);
    obsTexts.push(
      norm.normalizeText(
        captureText(`Capture ${ctx.postAction.capture}, taken right after the previous action (${ago} s before the current one):`, ctx.postAction, ctx.scrub),
        ctx.scrub,
      ),
    );
    images.push(imageFingerprint(ctx.postAction));
  }
  obsTexts.push(norm.normalizeText(captureText(`Capture ${ctx.current.capture}, current state:`, ctx.current, ctx.scrub), ctx.scrub));
  images.push(imageFingerprint(ctx.current));
  return { obsTexts, images };
}

function buildLookAgainTurn(seconds: number, obs: Observation, scrub: (s: string) => string, norm: RefNormalizer): NormalizedTurn {
  return {
    priorEvent: `look_again:${seconds}`,
    obsTexts: [norm.normalizeText(captureText(`Capture ${obs.capture}, after ${seconds} s:`, obs, scrub), scrub)],
    images: [imageFingerprint(obs)],
  };
}

function computeCanonicalKey(opts: {
  kind: 'act' | 'judge';
  info: Pick<ModelInfo, 'provider' | 'model' | 'tier' | 'effort'> | null;
  ctx: Pick<ActContext, 'plan' | 'step' | 'history' | 'scrub'>;
  norm: RefNormalizer;
  initialPrompt: string;
  turns: NormalizedTurn[];
}): { key: string; requestText: string; images: ImageFingerprint[] } {
  const payload = {
    cassetteSchema: CASSETTE_SCHEMA,
    normaliserVersion: NORMALISER_VERSION,
    kind: opts.kind,
    promptDigest: opts.kind === 'act' ? ACT_PROMPT_DIGEST : JUDGE_PROMPT_DIGEST,
    provider: opts.info?.provider ?? 'scripted',
    model: opts.info?.model ?? 'unknown',
    tier: opts.info?.tier ?? null,
    effort: opts.info?.effort ?? null,
    planId: opts.ctx.plan.id,
    planName: opts.norm.normalizeText(opts.ctx.plan.name, opts.ctx.scrub),
    stepId: opts.ctx.step.id,
    stepType: opts.ctx.step.type,
    stepText: opts.norm.normalizeText(opts.ctx.step.text, opts.ctx.scrub),
    history: opts.ctx.history.map((h) => ({
      stepId: h.stepId,
      type: h.type,
      text: opts.norm.normalizeText(h.text, opts.ctx.scrub),
      result: opts.norm.normalizeText(h.result, opts.ctx.scrub),
    })),
    initialPrompt: opts.initialPrompt,
    turns: opts.turns.map((t) => ({
      ...(t.priorEvent ? { priorEvent: t.priorEvent } : {}),
      obsTexts: t.obsTexts,
    })),
  };
  const canonical = JSON.stringify(payload);
  const requestText = [opts.initialPrompt, ...opts.turns.flatMap((t) => [...(t.priorEvent ? [t.priorEvent] : []), ...t.obsTexts])].join('\n');
  const images = opts.turns[opts.turns.length - 1]?.images ?? [];
  return { key: sha256Hex(canonical), requestText, images };
}

function isValidTier(v: unknown): v is Tier {
  return v === 'low' || v === 'medium' || v === 'high';
}

function validateHeader(cassettePath: string, raw: unknown): CassetteHeader {
  if (!isPlainObject(raw)) throw new ReplayMissError(`cassette "${cassettePath}" header must be an object`);
  if (raw.type !== 'header' || raw.cassetteSchema !== CASSETTE_SCHEMA || raw.normaliserVersion !== NORMALISER_VERSION) {
    throw new ReplayMissError(`cassette "${cassettePath}" has unsupported header or schema version`);
  }
  if (typeof raw.provider !== 'string' || !raw.provider || typeof raw.model !== 'string' || !raw.model) {
    throw new ReplayMissError(`cassette "${cassettePath}" header is missing provider or model`);
  }
  if (raw.tier !== null && !isValidTier(raw.tier)) {
    throw new ReplayMissError(`cassette "${cassettePath}" header has invalid tier`);
  }
  return raw as unknown as CassetteHeader;
}

function isValidResponse(res: unknown): res is CassetteResponse {
  if (!isPlainObject(res) || typeof res.type !== 'string') return false;
  switch (res.type) {
    case 'execute':
      return isPlainObject(res.action) && typeof res.action.tool === 'string';
    case 'act_return':
      return isPlainObject(res.outcome) && (res.outcome.status === 'done' || res.outcome.status === 'failed') && typeof res.outcome.summary === 'string';
    case 'look_again':
      return typeof res.seconds === 'number' && Number.isFinite(res.seconds) && res.seconds > 0;
    case 'judge_return':
      return isPlainObject(res.outcome) && (res.outcome.verdict === 'pass' || res.outcome.verdict === 'fail' || res.outcome.verdict === 'none');
    default:
      return false;
  }
}

function validateCallEntry(cassettePath: string, lineNo: number, raw: unknown): CassetteCallEntry {
  if (!isPlainObject(raw) || raw.type !== 'call') {
    throw new ReplayMissError(`cassette "${cassettePath}" line ${lineNo} must be a call entry`);
  }
  if (
    typeof raw.key !== 'string' ||
    !raw.key ||
    typeof raw.occurrence !== 'number' ||
    !Number.isInteger(raw.occurrence) ||
    raw.occurrence < 0 ||
    (raw.kind !== 'act' && raw.kind !== 'judge') ||
    typeof raw.planId !== 'string' ||
    typeof raw.stepId !== 'string' ||
    typeof raw.turn !== 'number' ||
    !Number.isInteger(raw.turn) ||
    raw.turn < 0 ||
    typeof raw.requestText !== 'string' ||
    !Array.isArray(raw.images)
  ) {
    throw new ReplayMissError(`cassette "${cassettePath}" line ${lineNo} is missing required call metadata`);
  }
  for (const img of raw.images) {
    if (!isPlainObject(img) || typeof img.sha256 !== 'string' || !img.sha256 || typeof img.dHash !== 'string' || !DHASH_RE.test(img.dHash)) {
      throw new ReplayMissError(`cassette "${cassettePath}" line ${lineNo} has an invalid image fingerprint`);
    }
  }
  if (!isValidResponse(raw.response)) {
    throw new ReplayMissError(`cassette "${cassettePath}" line ${lineNo} has an invalid response payload`);
  }
  return raw as unknown as CassetteCallEntry;
}

export interface RecordingAgentOptions {
  cassettePath: string;
}

/** Wraps any live or scripted Agent to record normalized, scrubbed act & judge interactions into cassette.jsonl. */
export class RecordingAgent implements Agent {
  private readonly occurrences = new Map<string, number>();
  private initialized = false;

  constructor(private readonly inner: Agent, private readonly opts: RecordingAgentOptions) {}

  get info(): ModelInfo | null {
    return this.inner.info;
  }

  get usage(): Usage {
    return this.inner.usage;
  }

  get limits() {
    return this.inner.limits;
  }

  private ensureHeader(): void {
    if (this.initialized) return;
    mkdirSync(path.dirname(path.resolve(this.opts.cassettePath)), { recursive: true });
    const header: CassetteHeader = {
      type: 'header',
      cassetteSchema: CASSETTE_SCHEMA,
      normaliserVersion: NORMALISER_VERSION,
      provider: this.inner.info?.provider ?? 'scripted',
      model: this.inner.info?.model ?? 'unknown',
      tier: this.inner.info?.tier ?? null,
      ...(this.inner.info?.effort ? { effort: this.inner.info.effort } : {}),
      platform: process.platform,
      createdAt: new Date().toISOString(),
    };
    writeFileSync(this.opts.cassettePath, JSON.stringify(header) + '\n', 'utf8');
    this.initialized = true;
  }

  private recordTurn(opts: {
    kind: 'act' | 'judge';
    ctx: Pick<ActContext, 'plan' | 'step' | 'rescan'>;
    turn: number;
    canonical: { key: string; requestText: string; images: ImageFingerprint[] };
    response: CassetteResponse;
  }): void {
    const entry: Omit<CassetteCallEntry, 'type' | 'occurrence'> = {
      key: opts.canonical.key,
      kind: opts.kind,
      tier: this.inner.info?.tier ?? null,
      planId: opts.ctx.plan.id,
      stepId: opts.ctx.step.id,
      turn: opts.turn,
      requestText: opts.canonical.requestText,
      images: opts.canonical.images,
      response: opts.response,
    };
    assertCleanScrub([entry.planId, entry.requestText, JSON.stringify(entry.response)], opts.ctx.rescan, 'persist');
    this.ensureHeader();
    const occurrence = this.occurrences.get(entry.key) ?? 0;
    this.occurrences.set(entry.key, occurrence + 1);
    const line: CassetteCallEntry = { type: 'call', occurrence, ...entry };
    appendFileSync(this.opts.cassettePath, JSON.stringify(line) + '\n', 'utf8');
  }

  async act(ctx: ActContext): Promise<ActOutcome> {
    const norm = new RefNormalizer();
    const initialPrompt = norm.normalizeText(actInitialText(ctx), ctx.scrub);
    const turns: NormalizedTurn[] = [buildInitialActTurn(ctx.observation, ctx.scrub, norm)];
    let turn = 0;
    let current = computeCanonicalKey({ kind: 'act', info: this.inner.info, ctx, norm, initialPrompt, turns });

    const outcome = await this.inner.act({
      ...ctx,
      execute: async (action) => {
        const normAction = norm.normalizeAction(action, ctx.scrub);
        this.recordTurn({ kind: 'act', ctx, turn, canonical: current, response: { type: 'execute', action: normAction } });
        const r = await ctx.execute(action);
        turn++;
        turns.push(buildExecuteTurn(normAction, r, ctx.scrub, norm));
        current = computeCanonicalKey({ kind: 'act', info: this.inner.info, ctx, norm, initialPrompt, turns });
        return r;
      },
    });

    this.recordTurn({ kind: 'act', ctx, turn, canonical: current, response: { type: 'act_return', outcome: norm.normalizeActOutcome(outcome, ctx.scrub) } });
    return outcome;
  }

  async judge(ctx: JudgeContext): Promise<JudgeOutcome> {
    const norm = new RefNormalizer();
    const initialPrompt = norm.normalizeText(judgeInitialText(ctx), ctx.scrub);
    const turns: NormalizedTurn[] = [buildInitialJudgeTurn(ctx, norm)];
    let turn = 0;
    let current = computeCanonicalKey({ kind: 'judge', info: this.inner.info, ctx, norm, initialPrompt, turns });

    const outcome = await this.inner.judge({
      ...ctx,
      lookAgain: async (seconds) => {
        this.recordTurn({ kind: 'judge', ctx, turn, canonical: current, response: { type: 'look_again', seconds } });
        const obs = await ctx.lookAgain(seconds);
        turn++;
        turns.push(buildLookAgainTurn(seconds, obs, ctx.scrub, norm));
        current = computeCanonicalKey({ kind: 'judge', info: this.inner.info, ctx, norm, initialPrompt, turns });
        return obs;
      },
    });

    this.recordTurn({ kind: 'judge', ctx, turn, canonical: current, response: { type: 'judge_return', outcome: norm.normalizeJudgeOutcome(outcome, ctx.scrub) } });
    return outcome;
  }
}

export interface ReplayAgentOptions {
  tier?: Tier;
  model?: string;
  provider?: string;
  effort?: string;
  maxDHashDistance?: number;
}

/** Deterministic offline replay agent keyed by scrubbed, normalized request hash + occurrence + image dHash. */
export class ReplayAgent implements Agent {
  readonly info: ModelInfo;
  readonly usage: Usage = { calls: 0, inputTokens: 0, outputTokens: 0 };
  readonly limits = { maxTokens: DEFAULT_MAX_TOKENS, maxTurns: DEFAULT_MAX_ACT_TURNS };
  readonly stats: ReplayInfo;
  private readonly entriesBySlot = new Map<string, CassetteCallEntry>();
  private readonly allEntries: CassetteCallEntry[];
  private readonly seenOccurrences = new Map<string, number>();
  private readonly maxDHashDistance: number;

  private constructor(
    header: CassetteHeader,
    entries: CassetteCallEntry[],
    cassettePath: string,
    cassetteSha256: string,
    maxDHashDistance: number,
  ) {
    this.allEntries = entries;
    this.maxDHashDistance = maxDHashDistance;
    for (const e of entries) {
      const slot = `${e.key}:${e.occurrence}`;
      if (this.entriesBySlot.has(slot)) {
        throw new ReplayMissError(`cassette "${cassettePath}" has duplicate slot ${slot}`);
      }
      this.entriesBySlot.set(slot, e);
    }
    this.stats = {
      cassette: path.basename(cassettePath),
      cassetteSha256,
      hits: 0,
      misses: 0,
      imageMismatches: 0,
    };
    this.info = {
      provider: header.provider,
      model: header.model,
      ...(header.effort ? { effort: header.effort } : {}),
      ...(header.tier ? { tier: header.tier } : {}),
      replay: this.stats,
    };
  }

  static async fromFile(cassettePath: string, opts: ReplayAgentOptions = {}): Promise<ReplayAgent> {
    let raw: Buffer;
    try {
      raw = await readFile(cassettePath);
    } catch (e) {
      throw new ReplayMissError(`cannot read cassette "${cassettePath}": ${(e as Error).message}`);
    }
    const cassetteSha256 = sha256Hex(raw);
    const lines = raw.toString('utf8').split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) {
      throw new ReplayMissError(`cassette "${cassettePath}" is empty`);
    }

    let rawHeader: unknown;
    try {
      rawHeader = JSON.parse(lines[0]!);
    } catch {
      throw new ReplayMissError(`cassette "${cassettePath}" has corrupt header JSON`);
    }
    const header = validateHeader(cassettePath, rawHeader);

    if (opts.tier !== undefined && header.tier !== opts.tier) {
      throw new ReplayMissError(`cassette tier mismatch: expected "${opts.tier}" but cassette recorded "${header.tier ?? 'none'}"`);
    }
    if (opts.model !== undefined && header.model !== opts.model) {
      throw new ReplayMissError(`cassette model mismatch: expected "${opts.model}" but cassette recorded "${header.model}"`);
    }
    if (opts.provider !== undefined && header.provider !== opts.provider) {
      throw new ReplayMissError(`cassette provider mismatch: expected "${opts.provider}" but cassette recorded "${header.provider}"`);
    }
    if (opts.effort !== undefined && header.effort !== opts.effort) {
      throw new ReplayMissError(`cassette effort mismatch: expected "${opts.effort}" but cassette recorded "${header.effort ?? 'none'}"`);
    }

    const entries: CassetteCallEntry[] = [];
    for (let i = 1; i < lines.length; i++) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(lines[i]!);
      } catch {
        throw new ReplayMissError(`cassette "${cassettePath}" line ${i + 1} is corrupt JSON`);
      }
      entries.push(validateCallEntry(cassettePath, i + 1, parsed));
    }

    return new ReplayAgent(header, entries, cassettePath, cassetteSha256, opts.maxDHashDistance ?? DEFAULT_MAX_DHASH_DISTANCE);
  }

  private lookup(opts: {
    kind: 'act' | 'judge';
    ctx: Pick<ActContext, 'plan' | 'step' | 'rescan'>;
    turn: number;
    canonical: { key: string; requestText: string; images: ImageFingerprint[] };
  }): CassetteCallEntry {
    const { kind, ctx, turn, canonical } = opts;
    const occ = this.seenOccurrences.get(canonical.key) ?? 0;
    const entry = this.entriesBySlot.get(`${canonical.key}:${occ}`);
    if (!entry) {
      this.stats.misses++;
      const closest = this.allEntries.find((e) => e.kind === kind && e.planId === ctx.plan.id && e.stepId === ctx.step.id);
      const hint = closest ? `closest recorded turn ${closest.turn} first line: ${closest.requestText.split('\n')[0]}` : 'no calls recorded for this step';
      throw new ReplayMissError(
        `cassette miss for ${kind} ${ctx.plan.id}/${ctx.step.id} turn ${turn} (key ${canonical.key.slice(0, 12)}…, occurrence ${occ}; ${hint})`,
      );
    }

    if (entry.requestText !== canonical.requestText) {
      this.stats.misses++;
      throw new ReplayMissError(`cassette request text mismatch for ${kind} ${ctx.plan.id}/${ctx.step.id} turn ${turn}`);
    }

    // Rescan incoming request and recorded response BEFORE accepting replay hit.
    assertCleanScrub([canonical.requestText, entry.requestText, JSON.stringify(entry.response)], ctx.rescan, 'replay');

    if (entry.images.length !== canonical.images.length) {
      this.stats.misses++;
      throw new ReplayMissError(`cassette image count mismatch for ${kind} ${ctx.plan.id}/${ctx.step.id} turn ${turn}`);
    }
    for (let i = 0; i < entry.images.length; i++) {
      const exp = entry.images[i]!;
      const got = canonical.images[i]!;
      if (exp.sha256 !== got.sha256) {
        const dist = dhashDistance(exp.dHash, got.dHash);
        if (dist > this.maxDHashDistance) {
          this.stats.misses++;
          throw new ReplayMissError(
            `cassette visual mismatch for ${kind} ${ctx.plan.id}/${ctx.step.id} turn ${turn} (dHash distance ${dist} > ${this.maxDHashDistance})`,
          );
        }
        this.stats.imageMismatches++;
      }
    }

    this.seenOccurrences.set(canonical.key, occ + 1);
    this.stats.hits++;
    this.usage.calls++;
    return entry;
  }

  async act(ctx: ActContext): Promise<ActOutcome> {
    const norm = new RefNormalizer();
    const initialPrompt = norm.normalizeText(actInitialText(ctx), ctx.scrub);
    const turns: NormalizedTurn[] = [buildInitialActTurn(ctx.observation, ctx.scrub, norm)];
    let turn = 0;

    while (true) {
      const canonical = computeCanonicalKey({ kind: 'act', info: this.info, ctx, norm, initialPrompt, turns });
      const entry = this.lookup({ kind: 'act', ctx, turn, canonical });
      if (entry.response.type === 'execute') {
        const realAction = norm.denormalizeAction(entry.response.action);
        const r = await ctx.execute(realAction);
        turn++;
        turns.push(buildExecuteTurn(entry.response.action, r, ctx.scrub, norm));
        continue;
      }
      if (entry.response.type === 'act_return') {
        return norm.denormalizeActOutcome(entry.response.outcome);
      }
      throw new ReplayMissError(`unexpected cassette response type "${entry.response.type}" in act`);
    }
  }

  async judge(ctx: JudgeContext): Promise<JudgeOutcome> {
    const norm = new RefNormalizer();
    const initialPrompt = norm.normalizeText(judgeInitialText(ctx), ctx.scrub);
    const turns: NormalizedTurn[] = [buildInitialJudgeTurn(ctx, norm)];
    let turn = 0;

    while (true) {
      const canonical = computeCanonicalKey({ kind: 'judge', info: this.info, ctx, norm, initialPrompt, turns });
      const entry = this.lookup({ kind: 'judge', ctx, turn, canonical });
      if (entry.response.type === 'look_again') {
        const obs = await ctx.lookAgain(entry.response.seconds);
        turn++;
        turns.push(buildLookAgainTurn(entry.response.seconds, obs, ctx.scrub, norm));
        continue;
      }
      if (entry.response.type === 'judge_return') {
        return norm.denormalizeJudgeOutcome(entry.response.outcome);
      }
      throw new ReplayMissError(`unexpected cassette response type "${entry.response.type}" in judge`);
    }
  }
}
