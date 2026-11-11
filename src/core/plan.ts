// SPDX-License-Identifier: PolyForm-Shield-1.0.0
// Plan format miqyas-plan/1: a superset of TestSprite's action/assertion steps, every step with a stable id.

import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

export type StepType = 'action' | 'assertion';

export interface Locator {
  role?: string;
  name?: string;
  text?: string;
  label?: string;
  testId?: string;
}

/** Deterministic check, run by code before (instead of) the model. */
export interface Check {
  locator: Locator;
  expect: 'visible' | 'hidden' | { text: string } | { count: number };
}

export interface Step {
  id: string;
  type: StepType;
  text: string;
  check?: Check;
}

export interface Plan {
  format: 'miqyas-plan';
  version: 1;
  id: string;
  name: string;
  surface: 'web';
  steps: Step[];
  /** Where the plan came from; not part of the identity. */
  source: { file?: string; kind: 'miqyas' | 'testsprite' };
  /** True when step ids were derived at load time rather than stored in the file. */
  derivedIds: boolean;
}

export class PlanError extends Error {
  constructor(
    message: string,
    readonly file?: string,
  ) {
    super(file ? `${file}: ${message}` : message);
  }
}

type Json = Record<string, unknown>;

function isObject(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Ids for steps without one: s1, s2 … for actions and a1, a2 … for assertions, skipping ids already taken. */
function assignIds(steps: { id?: string; type: StepType }[]): string[] {
  const taken = new Set(steps.map((s) => s.id).filter((id): id is string => !!id));
  const next = { action: 1, assertion: 1 };
  return steps.map((s) => {
    if (s.id) return s.id;
    const prefix = s.type === 'action' ? 's' : 'a';
    let id: string;
    do id = `${prefix}${next[s.type]++}`;
    while (taken.has(id));
    taken.add(id);
    return id;
  });
}

function parseLocator(v: unknown, where: string, file?: string): Locator {
  if (!isObject(v)) throw new PlanError(`${where}.locator must be an object`, file);
  const loc: Locator = {};
  for (const key of ['role', 'name', 'text', 'label', 'testId'] as const) {
    const val = v[key];
    if (val === undefined) continue;
    if (typeof val !== 'string' || !val) throw new PlanError(`${where}.locator.${key} must be a non-empty string`, file);
    loc[key] = val;
  }
  if (!loc.role && !loc.text && !loc.label && !loc.testId)
    throw new PlanError(`${where}.locator needs role, text, label or testId`, file);
  return loc;
}

function parseCheck(v: unknown, where: string, file?: string): Check {
  if (!isObject(v)) throw new PlanError(`${where}.check must be an object`, file);
  const locator = parseLocator(v.locator, `${where}.check`, file);
  const e = v.expect;
  if (e === 'visible' || e === 'hidden') return { locator, expect: e };
  if (isObject(e) && typeof e.text === 'string') return { locator, expect: { text: e.text } };
  if (isObject(e) && typeof e.count === 'number' && Number.isInteger(e.count) && e.count >= 0)
    return { locator, expect: { count: e.count } };
  throw new PlanError(`${where}.check.expect must be "visible", "hidden", {text} or {count}`, file);
}

/**
 * Parse a plan object, native or TestSprite. `fallbackId` names plans that carry no id (TestSprite files are
 * named by their file stem).
 */
export function parsePlan(raw: unknown, fallbackId: string, file?: string): Plan {
  if (!isObject(raw)) throw new PlanError('a plan must be a JSON object', file);

  const isTestSprite = Array.isArray(raw.planSteps);
  const rawSteps = isTestSprite ? raw.planSteps : raw.steps;
  if (!isTestSprite) {
    if (raw.format !== 'miqyas-plan') throw new PlanError('format must be "miqyas-plan" (or a TestSprite plan with planSteps)', file);
    if (raw.version !== 1) throw new PlanError(`unsupported version ${String(raw.version)}`, file);
    if (raw.surface !== undefined && raw.surface !== 'web') throw new PlanError(`surface "${String(raw.surface)}" is not supported yet`, file);
  } else if (raw.type !== undefined && raw.type !== 'frontend') {
    throw new PlanError(`TestSprite plan type "${String(raw.type)}" is not supported (frontend only)`, file);
  }
  if (!Array.isArray(rawSteps) || rawSteps.length === 0) throw new PlanError('a plan needs at least one step', file);

  const partial = rawSteps.map((s, i) => {
    const where = `steps[${i}]`;
    if (!isObject(s)) throw new PlanError(`${where} must be an object`, file);
    if (s.type !== 'action' && s.type !== 'assertion') throw new PlanError(`${where}.type must be "action" or "assertion"`, file);
    // TestSprite calls the text "description"; ours is "text". Accept both.
    const text = typeof s.text === 'string' ? s.text : typeof s.description === 'string' ? s.description : undefined;
    if (!text || !text.trim()) throw new PlanError(`${where} needs text`, file);
    if (s.id !== undefined && (typeof s.id !== 'string' || !/^[A-Za-z0-9_.-]+$/.test(s.id)))
      throw new PlanError(`${where}.id must match [A-Za-z0-9_.-]+`, file);
    const step: { id?: string; type: StepType; text: string; check?: Check } = { type: s.type, text: text.trim() };
    if (typeof s.id === 'string') step.id = s.id;
    if (s.check !== undefined) {
      if (s.type !== 'assertion') throw new PlanError(`${where}: only assertions take a check`, file);
      step.check = parseCheck(s.check, where, file);
    }
    return step;
  });

  const seen = new Set<string>();
  for (const s of partial) {
    if (!s.id) continue;
    if (seen.has(s.id)) throw new PlanError(`duplicate step id "${s.id}"`, file);
    seen.add(s.id);
  }

  const derivedIds = partial.some((s) => !s.id);
  const ids = assignIds(partial);
  const steps: Step[] = partial.map((s, i) => ({ ...s, id: ids[i]! }));

  const id = typeof raw.id === 'string' && raw.id ? raw.id : fallbackId;
  const name = typeof raw.name === 'string' && raw.name ? raw.name : id;
  const plan: Plan = {
    format: 'miqyas-plan',
    version: 1,
    id,
    name,
    surface: 'web',
    steps,
    source: { kind: isTestSprite ? 'testsprite' : 'miqyas' },
    derivedIds,
  };
  if (file) plan.source.file = file;
  return plan;
}

export interface LintIssue {
  level: 'error' | 'warning';
  message: string;
}

/** Offline lint. A plan without an assertion is an error: it can only ever pass vacuously. */
export function lintPlan(plan: Plan): LintIssue[] {
  const issues: LintIssue[] = [];
  const assertions = plan.steps.filter((s) => s.type === 'assertion');
  if (assertions.length === 0) issues.push({ level: 'error', message: 'the plan has no assertion' });
  if (plan.derivedIds)
    issues.push({ level: 'warning', message: 'some steps have no stored id; run `miqyas import` to write stable ids' });
  if (plan.steps[plan.steps.length - 1]?.type === 'action')
    issues.push({ level: 'warning', message: 'the last step is an action that no assertion checks' });
  for (const s of plan.steps) {
    if (s.type === 'assertion' && secretNames(s.text).length > 0)
      issues.push({ level: 'error', message: `${s.id}: secrets can't appear in assertions` });
  }
  return issues;
}

/** The plan as it is stored on disk: ids fixed, source metadata dropped. */
export function serializePlan(plan: Plan): string {
  const out = {
    format: plan.format,
    version: plan.version,
    id: plan.id,
    name: plan.name,
    surface: plan.surface,
    steps: plan.steps.map((s) => (s.check ? { id: s.id, type: s.type, text: s.text, check: s.check } : { id: s.id, type: s.type, text: s.text })),
  };
  return JSON.stringify(out, null, 2) + '\n';
}

export async function loadPlanFile(file: string): Promise<Plan> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(file, 'utf8'));
  } catch (e) {
    throw new PlanError(`not valid JSON (${(e as Error).message})`, file);
  }
  return parsePlan(raw, path.basename(file, path.extname(file)), file);
}

/** Expand files and directories (non-recursive, *.json) into plan files, sorted by name. */
export async function resolvePlanFiles(inputs: string[]): Promise<string[]> {
  const files: string[] = [];
  for (const input of inputs) {
    const st = await stat(input).catch(() => undefined);
    if (!st) throw new PlanError(`no such file or directory`, input);
    if (st.isDirectory()) {
      const names = (await readdir(input)).filter((n) => n.endsWith('.json')).sort();
      files.push(...names.map((n) => path.join(input, n)));
    } else files.push(input);
  }
  if (files.length === 0) throw new PlanError('no plan files found');
  return files;
}

export async function loadPlans(inputs: string[]): Promise<Plan[]> {
  const files = await resolvePlanFiles(inputs);
  const plans = await Promise.all(files.map(loadPlanFile));
  const ids = new Set<string>();
  for (const p of plans) {
    if (ids.has(p.id)) throw new PlanError(`two plans share the id "${p.id}"`, p.source.file);
    ids.add(p.id);
  }
  return plans;
}

const SECRET = /\$\{secret\.([A-Za-z0-9_]+)\}/g;

/** Names of the secrets a text refers to. */
export function secretNames(text: string): string[] {
  return [...text.matchAll(SECRET)].map((m) => m[1]!);
}

/** Replace `${secret.NAME}` with MIQYAS_SECRET_NAME from `env`; returns undefined when one is missing. */
export function resolveSecrets(text: string, env: Record<string, string | undefined>): string | undefined {
  let missing = false;
  const out = text.replace(SECRET, (_, name: string) => {
    const v = env[`MIQYAS_SECRET_${name}`];
    if (v === undefined) missing = true;
    return v ?? '';
  });
  return missing ? undefined : out;
}
