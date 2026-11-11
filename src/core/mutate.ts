// SPDX-License-Identifier: PolyForm-Shield-1.0.0
// Mutate mode: break a copy of the served build on purpose, run the plans that should notice, and report the
// tester's own detection rate. The clean build is never modified.

import { createHash } from 'node:crypto';
import { cp, readFile, readdir, readlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { PlanResult } from './ledger.js';
import { cell } from './report.js';

interface MutationBase {
  id: string;
  title: string;
  /** Plan expected to catch it. */
  plan: string;
  /** The assertion (step id) in that plan written to catch it. */
  assertion?: string;
  probe: Probe;
}

export interface StringSwap extends MutationBase {
  kind: 'string-swap';
  from: string;
  to: string;
  /** File extensions to edit (default .js). */
  extensions?: string[];
}

/**
 * How a mutation is shown effective before the run, measured on the rendered page (SRS FR-M2). The probe opens the
 * build, clicks `steps` (Playwright selectors) in order to reach the target screen, sets `rootAttrs` on <html> and
 * appends `html` to <body> (both optional), then measures:
 * - `height`: `selector`'s box is 0 px high (or absent) on the mutated build and not on the clean one (CSS hide);
 * - `left`: `selector`'s left edge is at x=0 on the mutated build and not on the clean one (RTL flip);
 * - `text`: the screen shows the swap's new text and not the old one, and the clean build shows the old one.
 */
export interface Probe {
  steps?: string[];
  rootAttrs?: Record<string, string>;
  html?: string;
  measure: 'height' | 'left' | 'text';
  /** Element to measure (`height`, `left`). */
  selector?: string;
}

/** What a probe read on one build: px for `height` and `left`, null when the element is absent; the rendered text for `text`. */
export type Reading = number | string | null;

export interface CssMutation extends MutationBase {
  kind: 'css';
  css: string;
}

export type Mutation = StringSwap | CssMutation;

/** Another tool's published result on the same mutations, printed beside ours only when a preset carries one. */
export interface Baseline {
  tool: string;
  detected: number;
  of: number;
  /** Where the number comes from. */
  source: string;
}

export interface MutationPreset {
  name: string;
  description?: string;
  baseline?: Baseline;
  mutations: Mutation[];
}

export function parsePreset(raw: unknown, where = 'preset'): MutationPreset {
  const p = raw as { name?: unknown; description?: unknown; baseline?: unknown; mutations?: unknown };
  if (typeof p !== 'object' || p === null || typeof p.name !== 'string' || !Array.isArray(p.mutations))
    throw new Error(`${where}: expected {"name", "mutations": [...]}`);
  const ids = new Set<string>();
  const mutations = p.mutations.map((m, i): Mutation => {
    const at = `${where}: mutations[${i}]`;
    const o = m as Record<string, unknown>;
    for (const k of ['id', 'title', 'plan'] as const) if (typeof o[k] !== 'string' || !o[k]) throw new Error(`${at} needs "${k}"`);
    if (ids.has(o.id as string)) throw new Error(`${at}: duplicate id "${String(o.id)}"`);
    ids.add(o.id as string);
    const probe = parseProbe(o.probe, at, o.kind);
    const base = { id: o.id as string, title: o.title as string, plan: o.plan as string, ...(typeof o.assertion === 'string' ? { assertion: o.assertion } : {}), probe };
    if (o.kind === 'string-swap') {
      if (typeof o.from !== 'string' || !o.from || typeof o.to !== 'string') throw new Error(`${at}: string-swap needs "from" and "to"`);
      const sw: StringSwap = { ...base, kind: 'string-swap', from: o.from, to: o.to };
      if (Array.isArray(o.extensions)) sw.extensions = o.extensions.map(String);
      return sw;
    }
    if (typeof o.css !== 'string' || !o.css) throw new Error(`${at}: css needs "css"`);
    return { ...base, kind: 'css', css: o.css };
  });
  const preset: MutationPreset = { name: p.name, mutations };
  if (typeof p.description === 'string') preset.description = p.description;
  if (p.baseline !== undefined) {
    const b = p.baseline as Record<string, unknown>;
    const count = (n: unknown) => Number.isInteger(n) && (n as number) >= 0;
    if (typeof b !== 'object' || b === null || typeof b.tool !== 'string' || !b.tool || typeof b.source !== 'string' || !b.source || !count(b.detected) || !count(b.of) || (b.detected as number) > (b.of as number))
      throw new Error(`${where}: baseline needs {"tool", "detected", "of", "source"}, with detected ≤ of`);
    preset.baseline = { tool: b.tool, detected: b.detected as number, of: b.of as number, source: b.source };
  }
  return preset;
}

function parseProbe(raw: unknown, at: string, kind: unknown): Probe {
  if (kind !== 'string-swap' && kind !== 'css') throw new Error(`${at}: kind must be "string-swap" or "css"`);
  const pr = raw as Record<string, unknown> | undefined;
  const measures = kind === 'string-swap' ? ['text'] : ['height', 'left'];
  if (!pr || typeof pr !== 'object' || !measures.includes(pr.measure as string))
    throw new Error(`${at}: ${kind} needs a probe {"measure": ${measures.map((m) => `"${m}"`).join(' or ')}, ...}`);
  const probe: Probe = { measure: pr.measure as Probe['measure'] };
  if (probe.measure !== 'text') {
    if (typeof pr.selector !== 'string' || !pr.selector) throw new Error(`${at}: a "${probe.measure}" probe needs "selector"`);
    probe.selector = pr.selector;
  }
  if (pr.steps !== undefined) {
    if (!Array.isArray(pr.steps) || pr.steps.some((x) => typeof x !== 'string' || !x)) throw new Error(`${at}: probe "steps" must be selectors`);
    probe.steps = pr.steps as string[];
  }
  if (typeof pr.html === 'string') probe.html = pr.html;
  if (pr.rootAttrs && typeof pr.rootAttrs === 'object') probe.rootAttrs = pr.rootAttrs as Record<string, string>;
  return probe;
}

const px = (r: Reading) => (r === null ? 'absent' : typeof r === 'number' ? `${r} px` : 'text');

/** Whether the probe readings show the mutation changed what renders, and the clean build doesn't show it. */
export function judgeProbe(m: Mutation, onClean: Reading, onMutant: Reading): { effective: boolean; detail: string } {
  const p = m.probe;
  if (p.measure === 'text') {
    if (m.kind !== 'string-swap') return { effective: false, detail: 'a text probe needs a string swap' };
    const shows = (r: Reading, t: string) => typeof r === 'string' && r.includes(t);
    // The old text may be part of the new one ("empty" → "not empty"): look for it outside the new text.
    const rest = typeof onMutant === 'string' ? onMutant.split(m.to).join('\n') : null;
    const effective = shows(onMutant, m.to) && !shows(rest, m.from) && shows(onClean, m.from);
    const yn = (b: boolean) => (b ? 'yes' : 'no');
    return {
      effective,
      detail: `probe text: clean shows "${m.from}" ${yn(shows(onClean, m.from))}; mutated shows "${m.to}" ${yn(shows(onMutant, m.to))}, "${m.from}" ${yn(shows(rest, m.from))}`,
    };
  }
  const at0 = (r: Reading) => typeof r === 'number' && Math.abs(r) < 1;
  const effective =
    p.measure === 'height' ? (onMutant === null || at0(onMutant)) && typeof onClean === 'number' && !at0(onClean) : at0(onMutant) && typeof onClean === 'number' && !at0(onClean);
  return { effective, detail: `probe ${p.measure} of ${p.selector}: clean ${px(onClean)}, mutated ${px(onMutant)}` };
}

async function filesWithExt(dir: string, exts: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const d of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) out.push(...(await filesWithExt(p, exts)));
    else if (exts.includes(path.extname(d.name).toLowerCase())) out.push(p);
  }
  return out;
}

function count(hay: string, needle: string): number {
  let n = 0;
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + needle.length)) n++;
  return n;
}

export interface Applied {
  mutation: Mutation;
  dir: string;
  /** What changed, for the report. */
  detail: string;
  /** Files changed, relative to the build. */
  files: string[];
}

export class MutationError extends Error {}

/** The clean build changed during a mutate run (FR-M1 forbids it). */
export class BuildChangedError extends Error {}

/** SHA-256 over every entry's relative path, in sorted order: directories by name, files by length and bytes, links by target. */
export async function hashDir(dir: string): Promise<string> {
  const h = createHash('sha256');
  const walk = async (d: string): Promise<void> => {
    for (const e of (await readdir(d, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const p = path.join(d, e.name);
      const rel = path.relative(dir, p).split(path.sep).join('/');
      if (e.isSymbolicLink()) h.update(`link\0${rel}\0${await readlink(p)}\0`);
      else if (e.isDirectory()) {
        h.update(`dir\0${rel}\0`);
        await walk(p);
      } else {
        const bytes = await readFile(p);
        h.update(`file\0${rel}\0${bytes.length}\0`).update(bytes);
      }
    }
  };
  await walk(dir);
  return h.digest('hex');
}

/** Run `fn`, then throw BuildChangedError if `dir` no longer hashes the same; that error wins over one `fn` threw. */
export async function keepUnchanged<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const before = await hashDir(dir);
  try {
    return await fn();
  } finally {
    const after = await hashDir(dir);
    if (after !== before) throw new BuildChangedError(`the clean build ${dir} changed during the run (sha256 ${before.slice(0, 12)} → ${after.slice(0, 12)})`);
  }
}

/** Marker put in index.html so a served mutated build can be recognised. */
export function cssMarker(id: string): string {
  return `data-miqyas-mutation="${id}"`;
}

/** Apply one mutation to a fresh copy of `buildDir` at `outDir`. Throws MutationError when it doesn't apply. */
export async function applyMutation(m: Mutation, buildDir: string, outDir: string): Promise<Applied> {
  await cp(buildDir, outDir, { recursive: true, errorOnExist: false, force: true });
  if (m.kind === 'string-swap') {
    const files = await filesWithExt(outDir, m.extensions ?? ['.js']);
    let replaced = 0;
    const changed: string[] = [];
    for (const f of files) {
      const text = await readFile(f, 'utf8');
      const n = count(text, m.from);
      if (n === 0) continue;
      await writeFile(f, text.split(m.from).join(m.to), 'utf8');
      replaced += n;
      changed.push(path.relative(outDir, f));
    }
    if (replaced === 0) throw new MutationError(`${m.id}: "${m.from}" is not in the build`);
    for (const f of files) if (count(await readFile(f, 'utf8'), m.from) > 0) throw new MutationError(`${m.id}: "${m.from}" still present after the swap`);
    return { mutation: m, dir: outDir, detail: `${replaced} occurrence(s) of "${m.from}" → "${m.to}"`, files: changed };
  }
  const index = path.join(outDir, 'index.html');
  const html = await readFile(index, 'utf8').catch(() => {
    throw new MutationError(`${m.id}: the build has no index.html`);
  });
  if (!html.includes('</head>')) throw new MutationError(`${m.id}: index.html has no </head>`);
  const tag = `<style ${cssMarker(m.id)}>${m.css}</style>`;
  await writeFile(index, html.replace('</head>', `${tag}</head>`), 'utf8');
  return { mutation: m, dir: outDir, detail: `added ${m.css}`, files: ['index.html'] };
}

export type Outcome =
  | 'detected' // the targeted assertion failed
  | 'detected_elsewhere' // the plan failed, but on another assertion
  | 'missed' // the plan passed on a broken build
  | 'inconclusive' // the plan doesn't pass on the clean build, so a failure proves nothing
  | 'ineffective' // the probe shows the mutation changed nothing
  | 'error' // the mutated run errored
  | 'not_run'; // dry run: applied and probed, not judged

export interface MutationResult {
  id: string;
  title: string;
  kind: Mutation['kind'];
  plan: string;
  assertion?: string;
  outcome: Outcome;
  detail: string;
  /** Assertions that didn't pass on the mutated build. */
  caughtBy: string[];
  observation?: string;
}

export function classify(m: Mutation, effective: boolean, baseline: PlanResult | undefined, mutated: PlanResult | undefined, detail: string): MutationResult {
  const base: MutationResult = { id: m.id, title: m.title, kind: m.kind, plan: m.plan, outcome: 'ineffective', detail, caughtBy: [] };
  if (m.assertion) base.assertion = m.assertion;
  if (!effective) return base;
  if (!baseline || baseline.verdict !== 'pass') return { ...base, outcome: 'inconclusive', detail: `${detail}; clean-build run: ${baseline?.verdict ?? 'missing'}` };
  if (!mutated) return { ...base, outcome: 'error', detail: `${detail}; no mutated run` };
  const failing = mutated.entries.filter((e) => e.kind === 'assertion' && e.verdict !== 'pass');
  const caughtBy = failing.map((e) => e.stepId);
  const target = failing.find((e) => e.stepId === m.assertion);
  const obs = target?.kind === 'assertion' ? target.observation : undefined;
  if (mutated.verdict === 'pass') return { ...base, outcome: 'missed', caughtBy };
  if (target?.kind === 'assertion' && target.verdict === 'fail')
    return { ...base, outcome: 'detected', caughtBy, ...(obs ? { observation: obs } : {}) };
  if (mutated.verdict === 'error') return { ...base, outcome: 'error', caughtBy, detail: `${detail}; ${mutated.error ?? 'run error'}` };
  if (!m.assertion) return { ...base, outcome: 'detected', caughtBy };
  const first = failing[0];
  return { ...base, outcome: 'detected_elsewhere', caughtBy, ...(first?.kind === 'assertion' && first.observation ? { observation: first.observation } : {}) };
}

/** Stryker: killed and survived mutants are valid; the rest (could not be judged) are excluded. One definition for the
 * mutation report and the bench. */
const KILLED: Outcome[] = ['detected', 'detected_elsewhere'];
const SURVIVED: Outcome[] = ['missed'];

export function validity(results: MutationResult[]): { killed: number; survived: number; valid: number; excluded: Partial<Record<Outcome, number>> } {
  const killed = results.filter((r) => KILLED.includes(r.outcome)).length;
  const survived = results.filter((r) => SURVIVED.includes(r.outcome)).length;
  const excluded: Partial<Record<Outcome, number>> = {};
  for (const r of results) if (!KILLED.includes(r.outcome) && !SURVIVED.includes(r.outcome)) excluded[r.outcome] = (excluded[r.outcome] ?? 0) + 1;
  return { killed, survived, valid: killed + survived, excluded };
}

/** "1 error, 2 not effective", for the line beside a score. */
export function excludedText(excluded: Partial<Record<Outcome, number>>): string {
  return Object.entries(excluded).map(([k, n]) => `${n} ${k === 'ineffective' ? 'not effective' : k.replaceAll('_', ' ')}`).join(', ');
}

export interface MutationSummary {
  preset: string;
  baseline?: Baseline;
  results: MutationResult[];
  /** Valid mutations (Stryker): killed or survived. Run errors, inconclusive, not effective and not run are excluded. */
  valid: number;
  /** The mutations left out of the rate, by outcome. */
  excluded: Partial<Record<Outcome, number>>;
  detected: number;
  detectedElsewhere: number;
  rate: number | null;
}

export function summarize(preset: string, results: MutationResult[], baseline?: Baseline): MutationSummary {
  const { valid, excluded } = validity(results);
  const detected = results.filter((r) => r.outcome === 'detected').length;
  const detectedElsewhere = results.filter((r) => r.outcome === 'detected_elsewhere').length;
  const s: MutationSummary = { preset, results, valid, excluded, detected, detectedElsewhere, rate: valid ? detected / valid : null };
  if (baseline) s.baseline = baseline;
  return s;
}

export function renderMutationMarkdown(s: MutationSummary, extra: { runId: string; url?: string; dryRun: boolean }): string {
  const lines = [`# Miqyas mutation run ${extra.runId}`, ''];
  if (extra.dryRun) lines.push('**DRY RUN**: mutations applied, probed and served; no plan was judged.', '');
  else
    lines.push(
      `**Detection rate: ${s.detected} of ${s.valid} valid${s.rate === null ? '' : ` (${Math.round(s.rate * 100)} %)`}** by the targeted assertion` +
        (Object.keys(s.excluded).length ? `; excluded: ${excludedText(s.excluded)}` : '') +
        (s.detectedElsewhere ? `; ${s.detectedElsewhere} more caught by another assertion (counted apart)` : '') +
        '.' +
        (s.baseline ? ` ${s.baseline.tool} on the same mutations: ${s.baseline.detected} of ${s.baseline.of} (${s.baseline.source}).` : ''),
      '',
    );
  const notEffective = s.results.filter((r) => r.outcome === 'ineffective').length;
  if (notEffective) lines.push(`${notEffective} mutation(s) not effective (not applied, or the probe did not confirm a change on the rendered page), so they don't count toward the detection rate.`, '');
  lines.push('| Mutation | Kind | Plan / assertion | Outcome | Caught by | Detail |', '|---|---|---|---|---|---|');
  for (const r of s.results)
    lines.push(`| ${cell(r.id)}: ${cell(r.title)} | ${r.kind} | ${cell(r.plan)}${r.assertion ? ` / ${r.assertion}` : ''} | ${r.outcome === 'ineffective' ? 'not effective' : r.outcome} | ${r.caughtBy.join(', ')} | ${cell(r.detail)}${r.observation ? `; seen: ${cell(r.observation)}` : ''} |`);
  lines.push('');
  return lines.join('\n');
}
