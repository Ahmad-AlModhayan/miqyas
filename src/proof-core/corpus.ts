// SPDX-License-Identifier: PolyForm-Shield-1.0.0
// Verification corpus contracts & validation (FR-B11, #15):
// 10 defect categories + readiness + clean twin baselines (known-findings.json),
// mandatory code effectiveness probes per seed, strict blindness lint, and safe path containment.

import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { Probe, Reading, SurfaceDriver } from '../surfaces/session.js';
import { applyMutation, judgeProbe, keepUnchanged, MutationError, type Mutation } from './mutate.js';
import type { Plan } from './plan.js';

export const CORPUS_CATEGORIES = [
  'broken-flow',
  'validation',
  'css-visibility',
  'layout-rtl',
  'accessibility',
  'runtime-error',
  'auth-access',
  'secret-leak',
  'xss-injection',
  'spend-abuse',
] as const;

export type CorpusCategory = (typeof CORPUS_CATEGORIES)[number];

export const CORPUS_PARTS = ['asserted', 'unasserted', 'readiness'] as const;
export type CorpusPart = (typeof CORPUS_PARTS)[number];

const CATEGORY_SET = new Set<string>(CORPUS_CATEGORIES);
const PART_SET = new Set<string>(CORPUS_PARTS);
const SEED_ID_RE = /^[A-Za-z0-9_.-]+$/;
const SAFE_PATH_RE = /^\/(?!\/)/;
const MAX_PATTERN_LEN = 200;
const NESTED_QUANTIFIER_RE = /\([^)]*[+*?][^)]*\)[+*{]/;
const REPEATED_QUANTIFIER_RE = /[+*]{2,}|\}\s*[+*?{]/;

export class CorpusError extends Error {}

export interface KnownFindingEntry {
  id: string;
  category: string;
  severity?: 'info' | 'low' | 'medium' | 'high' | 'critical';
  urlPattern?: string;
  evidencePattern: string;
  rationale: string;
}

export interface KnownFindingsBaseline {
  version: 1;
  target: string;
  buildId: string;
  reviewedAt: string;
  reviewer: string;
  entries: KnownFindingEntry[];
}

export interface CorpusSeedProbe extends Probe {
  expectClean?: string;
  expectSeed?: string;
}

export type CorpusSeedMutation =
  | { kind: 'string-swap'; from: string; to: string; extensions?: string[] }
  | { kind: 'css'; css: string };

export interface CorpusSeed {
  id: string;
  title: string;
  part: CorpusPart;
  category: CorpusCategory;
  plan?: string;
  assertion?: string;
  readinessCheck?: string;
  blindTokens?: string[];
  fixtureDir?: string;
  mutation?: CorpusSeedMutation;
  probe: CorpusSeedProbe;
}

export interface CorpusManifest {
  version: 1;
  target: string;
  description?: string;
  cleanTwin: {
    buildDir: string;
    knownFindings: string;
    url?: string;
  };
  seeds: CorpusSeed[];
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function nonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

/** Validate and compile a pattern from `known-findings.json` with length and backtracking bounds. */
export function compileKnownPattern(pattern: string, where = 'known-findings'): RegExp {
  if (pattern.length > MAX_PATTERN_LEN) {
    throw new CorpusError(`${where}: pattern exceeds ${MAX_PATTERN_LEN} characters`);
  }
  if (NESTED_QUANTIFIER_RE.test(pattern) || REPEATED_QUANTIFIER_RE.test(pattern)) {
    throw new CorpusError(`${where}: nested or repeated quantifiers are not allowed in regex pattern`);
  }
  try {
    return new RegExp(pattern, 'i');
  } catch (e) {
    throw new CorpusError(`${where}: invalid regex pattern (${(e as Error).message})`);
  }
}

function parseSeedProbe(raw: unknown, where: string, mutation?: CorpusSeedMutation): CorpusSeedProbe {
  if (!isObject(raw)) throw new CorpusError(`${where}: missing code effectiveness "probe" object`);
  const measure = raw.measure;
  if (measure !== 'height' && measure !== 'left' && measure !== 'text') {
    throw new CorpusError(`${where}: probe.measure must be "height", "left", or "text"`);
  }
  if (measure !== 'text' && !nonEmptyString(raw.selector)) {
    throw new CorpusError(`${where}: "${measure}" probe needs a non-empty "selector"`);
  }
  if ((raw.expectClean !== undefined || raw.expectSeed !== undefined) && measure !== 'text') {
    throw new CorpusError(`${where}: expectClean/expectSeed require probe.measure === "text"`);
  }
  if (mutation?.kind === 'css' && measure === 'text' && !nonEmptyString(raw.expectClean) && !nonEmptyString(raw.expectSeed)) {
    throw new CorpusError(`${where}: css seed using text probe must set expectClean/expectSeed`);
  }

  const out: CorpusSeedProbe = { measure };
  if (raw.path !== undefined) {
    if (!nonEmptyString(raw.path) || !SAFE_PATH_RE.test(raw.path) || raw.path.includes('\\')) {
      throw new CorpusError(`${where}: probe.path must be a same-origin root-relative path starting with "/"`);
    }
    out.path = raw.path;
  }
  if (raw.selector !== undefined) {
    if (!nonEmptyString(raw.selector)) throw new CorpusError(`${where}: probe.selector must be a non-empty string`);
    out.selector = raw.selector;
  }
  if (raw.html !== undefined) {
    if (typeof raw.html !== 'string') throw new CorpusError(`${where}: probe.html must be a string`);
    out.html = raw.html;
  }
  if (raw.rootAttrs !== undefined) {
    if (!isObject(raw.rootAttrs) || Object.values(raw.rootAttrs).some((v) => typeof v !== 'string')) {
      throw new CorpusError(`${where}: probe.rootAttrs must be an object mapping attribute names to strings`);
    }
    out.rootAttrs = { ...(raw.rootAttrs as Record<string, string>) };
  }
  if (raw.steps !== undefined) {
    if (!Array.isArray(raw.steps) || raw.steps.some((s) => !nonEmptyString(s))) {
      throw new CorpusError(`${where}: probe.steps must be non-empty selector strings`);
    }
    out.steps = raw.steps.map(String);
  }
  if (raw.expectClean !== undefined) {
    if (!nonEmptyString(raw.expectClean)) throw new CorpusError(`${where}: probe.expectClean must be non-empty`);
    out.expectClean = raw.expectClean;
  }
  if (raw.expectSeed !== undefined) {
    if (!nonEmptyString(raw.expectSeed)) throw new CorpusError(`${where}: probe.expectSeed must be non-empty`);
    out.expectSeed = raw.expectSeed;
  }
  return out;
}

function parseSeedMutation(raw: unknown, where: string): CorpusSeedMutation {
  if (!isObject(raw)) throw new CorpusError(`${where}: invalid "mutation"`);
  if (raw.kind === 'string-swap') {
    if (!nonEmptyString(raw.from) || typeof raw.to !== 'string') {
      throw new CorpusError(`${where}: string-swap mutation needs "from" and "to"`);
    }
    let extensions: string[] | undefined;
    if (raw.extensions !== undefined) {
      if (!Array.isArray(raw.extensions) || raw.extensions.some((e) => !nonEmptyString(e) || !e.startsWith('.'))) {
        throw new CorpusError(`${where}: mutation.extensions must be dot-prefixed strings (e.g. ".html")`);
      }
      extensions = [...raw.extensions];
    }
    return { kind: 'string-swap', from: raw.from, to: raw.to, ...(extensions ? { extensions } : {}) };
  }
  if (raw.kind === 'css') {
    if (!nonEmptyString(raw.css)) throw new CorpusError(`${where}: css mutation needs "css"`);
    return { kind: 'css', css: raw.css };
  }
  throw new CorpusError(`${where}: mutation.kind must be "string-swap" or "css"`);
}

function parseSeed(item: unknown, idx: number, where: string, seenIds: Set<string>): CorpusSeed {
  const at = `${where}: seeds[${idx}]`;
  if (!isObject(item)) throw new CorpusError(`${at}: seed must be an object`);
  if (!nonEmptyString(item.id) || !SEED_ID_RE.test(item.id)) {
    throw new CorpusError(`${at}: seed needs an "id" matching [A-Za-z0-9_.-]+`);
  }
  if (seenIds.has(item.id)) throw new CorpusError(`${at}: duplicate seed id "${item.id}"`);
  seenIds.add(item.id);
  if (!nonEmptyString(item.title)) throw new CorpusError(`${at}: seed "${item.id}" needs "title"`);
  if (!PART_SET.has(String(item.part))) {
    throw new CorpusError(`${at}: part must be one of ${CORPUS_PARTS.join(', ')}`);
  }
  const part = item.part as CorpusPart;
  if (!CATEGORY_SET.has(String(item.category))) {
    throw new CorpusError(`${at}: unknown category "${String(item.category)}" (expected one of ${CORPUS_CATEGORIES.join(', ')})`);
  }
  const category = item.category as CorpusCategory;

  if (part === 'unasserted') {
    if (item.plan !== undefined || item.assertion !== undefined || item.readinessCheck !== undefined) {
      throw new CorpusError(`${at}: unasserted seed "${item.id}" must stay blind and cannot declare "plan", "assertion", or "readinessCheck"`);
    }
  } else if (part === 'asserted') {
    if (!nonEmptyString(item.plan)) throw new CorpusError(`${at}: asserted seed "${item.id}" needs "plan"`);
    if (item.readinessCheck !== undefined || item.blindTokens !== undefined) {
      throw new CorpusError(`${at}: asserted seed "${item.id}" cannot declare "readinessCheck" or "blindTokens"`);
    }
  } else {
    if (!nonEmptyString(item.readinessCheck)) {
      throw new CorpusError(`${at}: readiness seed "${item.id}" needs "readinessCheck"`);
    }
    if (item.plan !== undefined || item.assertion !== undefined) {
      throw new CorpusError(`${at}: readiness seed "${item.id}" cannot declare "plan" or "assertion"`);
    }
  }

  const mutation = item.mutation !== undefined ? parseSeedMutation(item.mutation, at) : undefined;
  if (item.fixtureDir !== undefined && !nonEmptyString(item.fixtureDir)) {
    throw new CorpusError(`${at}: fixtureDir must be a non-empty string`);
  }
  if (!mutation && !nonEmptyString(item.fixtureDir)) {
    throw new CorpusError(`${at}: seed "${item.id}" needs either "mutation" or "fixtureDir"`);
  }

  let blindTokens: string[] | undefined;
  if (item.blindTokens !== undefined) {
    if (!Array.isArray(item.blindTokens) || item.blindTokens.some((t) => !nonEmptyString(t) || t.trim().length < 3)) {
      throw new CorpusError(`${at}: blindTokens must be strings of at least 3 non-whitespace characters`);
    }
    blindTokens = item.blindTokens.map((t) => (t as string).trim());
  }

  const probe = parseSeedProbe(item.probe, at, mutation);
  const seed: CorpusSeed = { id: item.id, title: item.title, part, category, probe };
  if (nonEmptyString(item.plan)) seed.plan = item.plan;
  if (nonEmptyString(item.assertion)) seed.assertion = item.assertion;
  if (nonEmptyString(item.readinessCheck)) seed.readinessCheck = item.readinessCheck;
  if (blindTokens) seed.blindTokens = blindTokens;
  if (nonEmptyString(item.fixtureDir)) seed.fixtureDir = item.fixtureDir;
  if (mutation) seed.mutation = mutation;
  return seed;
}

/** Validate per-build reviewed `known-findings.json` baseline for a clean twin. */
export function parseKnownFindings(raw: unknown, where = 'known-findings.json'): KnownFindingsBaseline {
  if (!isObject(raw) || raw.version !== 1) {
    throw new CorpusError(`${where}: expected {"version": 1, "target", "buildId", "reviewedAt", "reviewer", "entries": [...]}`);
  }
  for (const field of ['target', 'buildId', 'reviewedAt', 'reviewer'] as const) {
    if (!nonEmptyString(raw[field])) throw new CorpusError(`${where}: "${field}" must be a non-empty string`);
  }
  if (Number.isNaN(Date.parse(raw.reviewedAt as string))) {
    throw new CorpusError(`${where}: "reviewedAt" must be a valid ISO timestamp`);
  }
  if (!Array.isArray(raw.entries)) throw new CorpusError(`${where}: "entries" must be an array`);
  const seenIds = new Set<string>();
  const entries = raw.entries.map((item, idx): KnownFindingEntry => {
    const at = `${where}: entries[${idx}]`;
    if (!isObject(item)) throw new CorpusError(`${at}: must be an object`);
    if (!nonEmptyString(item.id)) throw new CorpusError(`${at}: missing "id"`);
    if (seenIds.has(item.id)) throw new CorpusError(`${at}: duplicate id "${item.id}"`);
    seenIds.add(item.id);
    if (!nonEmptyString(item.category)) throw new CorpusError(`${at}: missing "category"`);
    if (!nonEmptyString(item.evidencePattern)) throw new CorpusError(`${at}: missing "evidencePattern"`);
    if (!nonEmptyString(item.rationale)) throw new CorpusError(`${at}: missing review "rationale"`);
    compileKnownPattern(item.evidencePattern, `${at}.evidencePattern`);
    if (item.urlPattern !== undefined) {
      if (!nonEmptyString(item.urlPattern)) throw new CorpusError(`${at}.urlPattern: must be a non-empty string`);
      compileKnownPattern(item.urlPattern, `${at}.urlPattern`);
    }
    const entry: KnownFindingEntry = {
      id: item.id,
      category: item.category,
      evidencePattern: item.evidencePattern,
      rationale: item.rationale,
    };
    if (typeof item.urlPattern === 'string') entry.urlPattern = item.urlPattern;
    if (
      item.severity === 'info' ||
      item.severity === 'low' ||
      item.severity === 'medium' ||
      item.severity === 'high' ||
      item.severity === 'critical'
    ) {
      entry.severity = item.severity;
    } else if (item.severity !== undefined) {
      throw new CorpusError(`${at}: invalid severity "${String(item.severity)}"`);
    }
    return entry;
  });

  return {
    version: 1,
    target: (raw.target as string).trim(),
    buildId: (raw.buildId as string).trim(),
    reviewedAt: raw.reviewedAt as string,
    reviewer: (raw.reviewer as string).trim(),
    entries,
  };
}

/** Validate and normalize a `corpus/<target>/seeds.json` manifest. */
export function parseCorpusManifest(raw: unknown, where = 'seeds.json'): CorpusManifest {
  if (!isObject(raw) || raw.version !== 1 || !nonEmptyString(raw.target) || !isObject(raw.cleanTwin) || !Array.isArray(raw.seeds)) {
    throw new CorpusError(`${where}: expected {"version": 1, "target", "cleanTwin", "seeds": [...]}`);
  }
  if (raw.seeds.length === 0) throw new CorpusError(`${where}: "seeds" must contain at least one entry`);
  const cleanTwin = raw.cleanTwin;
  if (!nonEmptyString(cleanTwin.buildDir) || !nonEmptyString(cleanTwin.knownFindings)) {
    throw new CorpusError(`${where}: cleanTwin needs "buildDir" and "knownFindings"`);
  }
  const seenIds = new Set<string>();
  const seeds = raw.seeds.map((item, idx) => parseSeed(item, idx, where, seenIds));

  const manifest: CorpusManifest = {
    version: 1,
    target: raw.target.trim(),
    cleanTwin: {
      buildDir: cleanTwin.buildDir.trim(),
      knownFindings: cleanTwin.knownFindings.trim(),
      ...(nonEmptyString(cleanTwin.url) ? { url: cleanTwin.url } : {}),
    },
    seeds,
  };
  if (nonEmptyString(raw.description)) manifest.description = raw.description.trim();
  return manifest;
}

/** Convert a corpus seed with a mutation spec into a `Mutation` for Proof Core execution. */
export function seedToMutation(seed: CorpusSeed, defaultPlan = seed.plan ?? 'corpus'): Mutation | null {
  if (!seed.mutation) return null;
  if (seed.mutation.kind === 'string-swap') {
    return {
      id: seed.id,
      title: seed.title,
      plan: defaultPlan,
      ...(seed.assertion ? { assertion: seed.assertion } : {}),
      kind: 'string-swap',
      from: seed.mutation.from,
      to: seed.mutation.to,
      ...(seed.mutation.extensions ? { extensions: seed.mutation.extensions } : {}),
      probe: seed.probe,
    };
  }
  return {
    id: seed.id,
    title: seed.title,
    plan: defaultPlan,
    ...(seed.assertion ? { assertion: seed.assertion } : {}),
    kind: 'css',
    css: seed.mutation.css,
    probe: seed.probe,
  };
}

function isWithinRoot(candidate: string, root: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
}

/** Resolve a manifest/seed filesystem path strictly within allowed roots and reject symlink escapes. */
export async function resolveContainedCorpusPath(
  rawPath: string,
  allowedRoots: string[],
  label: string,
): Promise<string> {
  const realRoots = await Promise.all(
    allowedRoots.map((r) => realpath(r).catch(() => path.resolve(r))),
  );
  const resolved = path.isAbsolute(rawPath) ? path.resolve(rawPath) : path.resolve(allowedRoots[0]!, rawPath);
  if (!realRoots.some((root) => isWithinRoot(resolved, root))) {
    throw new CorpusError(`${label}: path "${rawPath}" escapes the corpus workspace`);
  }
  const st = await lstat(resolved).catch(() => null);
  if (st?.isSymbolicLink()) {
    throw new CorpusError(`${label}: symbolic links are not permitted (${rawPath})`);
  }
  if (st) {
    const canonical = await realpath(resolved);
    if (!realRoots.some((root) => isWithinRoot(canonical, root))) {
      throw new CorpusError(`${label}: canonical path "${rawPath}" escapes the corpus workspace`);
    }
  }
  return resolved;
}

function planSearchCorpus(plan: Plan): string {
  const stepText = plan.steps
    .flatMap((s) => [
      s.id,
      s.text,
      s.cite ? JSON.stringify(s.cite) : '',
      s.check ? JSON.stringify(s.check) : '',
    ])
    .join('\n');
  return `${plan.id}\n${plan.name}\n${stepText}`.toLowerCase();
}

/**
 * Lint a corpus against loaded plans and its clean-twin `known-findings.json` baseline:
 * - Rejects target mismatch on `known-findings.json`
 * - Rejects any `Plan` mentioning an `unasserted` seed's id, title, or `blindTokens`
 * - Validates `asserted` seeds point to existing plans/assertions
 */
export function lintCorpus(manifest: CorpusManifest, plans: readonly Plan[], knownFindings: KnownFindingsBaseline): void {
  if (knownFindings.target !== manifest.target) {
    throw new CorpusError(
      `known-findings target "${knownFindings.target}" does not match corpus target "${manifest.target}"`,
    );
  }
  const byPlanId = new Map(plans.map((p) => [p.id, p]));
  for (const seed of manifest.seeds) {
    if (seed.part === 'asserted' && seed.plan) {
      const plan = byPlanId.get(seed.plan);
      if (!plan) {
        throw new CorpusError(`asserted seed "${seed.id}" targets plan "${seed.plan}", which was not found`);
      }
      if (seed.assertion && !plan.steps.some((s) => s.id === seed.assertion && s.type === 'assertion')) {
        throw new CorpusError(
          `asserted seed "${seed.id}" targets assertion "${seed.assertion}", which plan "${seed.plan}" does not have`,
        );
      }
    }
    if (seed.part === 'unasserted') {
      const markers = [seed.id, seed.title, ...(seed.blindTokens ?? [])]
        .map((m) => m.trim().toLowerCase())
        .filter((m) => m.length >= 3);
      for (const plan of plans) {
        const haystack = planSearchCorpus(plan);
        const hit = markers.find((m) => haystack.includes(m));
        if (hit) {
          throw new CorpusError(
            `blindness violation: plan "${plan.id}" references unasserted seed "${seed.id}" (matched "${hit}")`,
          );
        }
      }
    }
  }
}

/** Judge whether a seed's code probe broke its target compared to the clean twin. */
export function judgeSeedProbe(
  seed: Pick<CorpusSeed, 'id' | 'title' | 'category' | 'part' | 'mutation' | 'probe'>,
  onClean: Reading,
  onSeed: Reading,
): { effective: boolean; detail: string } {
  if (seed.probe.expectClean !== undefined || seed.probe.expectSeed !== undefined) {
    const cleanStr = typeof onClean === 'string' ? onClean : '';
    const seedStr = typeof onSeed === 'string' ? onSeed : '';
    const cleanOk =
      (seed.probe.expectClean === undefined || cleanStr.includes(seed.probe.expectClean)) &&
      (seed.probe.expectSeed === undefined || seed.probe.expectSeed === seed.probe.expectClean || !cleanStr.includes(seed.probe.expectSeed));
    const withoutNew = seed.probe.expectSeed ? seedStr.replaceAll(seed.probe.expectSeed, '') : seedStr;
    const seedOk =
      (seed.probe.expectSeed === undefined || seedStr.includes(seed.probe.expectSeed)) &&
      (seed.probe.expectClean === undefined || seed.probe.expectSeed === seed.probe.expectClean || !withoutNew.includes(seed.probe.expectClean));
    return {
      effective: cleanOk && seedOk && cleanStr !== seedStr,
      detail: `probe text on ${seed.id}: clean=${JSON.stringify(cleanStr.slice(0, 60))}, seed=${JSON.stringify(seedStr.slice(0, 60))}`,
    };
  }
  const asMutation = seed.mutation ? seedToMutation(seed as CorpusSeed) : null;
  if (asMutation) return judgeProbe(asMutation, onClean, onSeed);

  // Fixture seeds without mutation follow the same measure checks as `judgeProbe`.
  if (seed.probe.measure === 'height') {
    const effective = typeof onClean === 'number' && onClean > 0 && (onSeed === 0 || onSeed === null);
    return { effective, detail: `probe height of ${seed.probe.selector}: clean ${String(onClean)} px, seed ${onSeed === null ? 'absent' : `${onSeed} px`}` };
  }
  if (seed.probe.measure === 'left') {
    const effective = typeof onClean === 'number' && onClean > 0 && onSeed === 0;
    return { effective, detail: `probe left of ${seed.probe.selector}: clean ${String(onClean)} px, seed ${String(onSeed)} px` };
  }
  const effective = onClean !== onSeed && onSeed !== null;
  return { effective, detail: `probe reading on ${seed.id}: clean=${String(onClean)}, seed=${String(onSeed)}` };
}

async function readJsonCorpusFile(filePath: string, label: string): Promise<unknown> {
  let rawText: string;
  try {
    rawText = await readFile(filePath, 'utf8');
  } catch (e) {
    throw new CorpusError(`${label} could not be read (${filePath}): ${(e as Error).message}`);
  }
  try {
    return JSON.parse(rawText);
  } catch (e) {
    throw new CorpusError(`${label} contains invalid JSON (${filePath}): ${(e as Error).message}`);
  }
}

/** Resolve and parse a corpus directory (`<dir>/seeds.json`) or manifest file alongside its `known-findings.json`. */
export async function loadCorpusFromPath(
  targetPath: string,
  baseRoot = process.cwd(),
): Promise<{
  manifestPath: string;
  manifest: CorpusManifest;
  cleanBuildDir: string;
  knownFindingsPath: string;
  knownFindings: KnownFindingsBaseline;
  baseDir: string;
}> {
  const manifestPath = targetPath.endsWith('.json') ? path.resolve(targetPath) : path.resolve(targetPath, 'seeds.json');
  const baseDir = path.dirname(manifestPath);
  const raw = await readJsonCorpusFile(manifestPath, 'corpus manifest');
  const manifest = parseCorpusManifest(raw, manifestPath);
  const roots = [baseRoot, baseDir];
  const cleanBuildDir = await resolveContainedCorpusPath(manifest.cleanTwin.buildDir, roots, 'cleanTwin.buildDir');
  const knownFindingsPath = await resolveContainedCorpusPath(manifest.cleanTwin.knownFindings, roots, 'cleanTwin.knownFindings');
  const knownRaw = await readJsonCorpusFile(knownFindingsPath, 'known-findings');
  const knownFindings = parseKnownFindings(knownRaw, knownFindingsPath);
  return { manifestPath, manifest, cleanBuildDir, knownFindingsPath, knownFindings, baseDir };
}

async function probeSeedDir(
  seed: CorpusSeed,
  seedDir: string,
  cleanReading: Reading,
  driver: SurfaceDriver,
  serve: (dir: string) => Promise<{ url: string; close(): Promise<void> }>,
): Promise<{ id: string; effective: boolean; detail: string }> {
  const seedSrv = await serve(seedDir);
  try {
    const seedReading = await driver.measureProbe!(seedSrv.url, seed.probe);
    return { id: seed.id, ...judgeSeedProbe(seed, cleanReading, seedReading) };
  } finally {
    await seedSrv.close();
  }
}

/** Verify every seed's code probe against the clean twin using the provided SurfaceDriver + static server. */
export async function verifyCorpusProbes(opts: {
  manifest: CorpusManifest;
  cleanBuildDir: string;
  baseRoot: string;
  driver: SurfaceDriver;
  serve: (dir: string) => Promise<{ url: string; close(): Promise<void> }>;
  workDir: string;
  baseDir?: string;
}): Promise<{ id: string; effective: boolean; detail: string }[]> {
  if (!opts.driver.measureProbe) {
    throw new CorpusError(`driver "${opts.driver.surface}" does not support code probes (measureProbe)`);
  }
  const results: { id: string; effective: boolean; detail: string }[] = [];
  const allowedRoots = opts.baseDir ? [opts.baseRoot, opts.baseDir] : [opts.baseRoot];

  await keepUnchanged(opts.cleanBuildDir, async () => {
    const cleanSrv = await opts.serve(opts.cleanBuildDir);
    try {
      for (const seed of opts.manifest.seeds) {
        const cleanReading = await opts.driver.measureProbe!(cleanSrv.url, seed.probe);
        if (seed.fixtureDir) {
          const seedDir = await resolveContainedCorpusPath(seed.fixtureDir, allowedRoots, `seed "${seed.id}" fixtureDir`);
          results.push(await probeSeedDir(seed, seedDir, cleanReading, opts.driver, opts.serve));
          continue;
        }
        const mutSpec = seedToMutation(seed);
        if (!mutSpec) continue;
        const mutDir = path.join(opts.workDir, 'probes', seed.id);
        try {
          await applyMutation(mutSpec, opts.cleanBuildDir, mutDir);
        } catch (e) {
          if (e instanceof MutationError) {
            results.push({ id: seed.id, effective: false, detail: e.message });
            continue;
          }
          throw e;
        }
        results.push(await probeSeedDir(seed, mutDir, cleanReading, opts.driver, opts.serve));
      }
    } finally {
      await cleanSrv.close();
    }
  });
  return results;
}
