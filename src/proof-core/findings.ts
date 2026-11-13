// SPDX-License-Identifier: PolyForm-Shield-1.0.0
// Security & quality findings collected outside the assertion ledger (Layer 3: proof-core).
// Includes always-on prompt-injection detection on rendered page content (#12) and shared Finding model for detectors (#13).

import type { ProposedFinding } from '../agents/agent.js';
import type { EvidenceNode, Observation, SnapNode, SurfaceFinding } from '../surfaces/session.js';
import { toEvidenceNode } from '../surfaces/web/observe.js';

export type FindingSeverity = 'info' | 'low' | 'medium' | 'high' | 'critical';
export type FailOnThreshold = 'none' | FindingSeverity;
export type FindingSource = 'code' | 'model';

export const SEVERITY_RANK: Record<FindingSeverity, number> = {
  info: 1,
  low: 2,
  medium: 3,
  high: 4,
  critical: 5,
};

const VALID_FAIL_ON = new Set<FailOnThreshold>(['none', 'info', 'low', 'medium', 'high', 'critical']);

/** Validate `--fail-on <severity>` option (`none` disables findings gating). */
export function parseFailOn(raw: string | undefined): FailOnThreshold {
  if (raw === undefined) return 'none';
  const norm = raw.trim().toLowerCase() as FailOnThreshold;
  if (!VALID_FAIL_ON.has(norm)) {
    throw new Error(`--fail-on must be one of none, info, low, medium, high, critical (got "${raw}")`);
  }
  return norm;
}

/** Return confirmed findings at or above the configured `--fail-on` severity threshold. */
export function findingsExceedThreshold(findings: readonly Finding[], failOn: FailOnThreshold | undefined): Finding[] {
  if (!failOn || failOn === 'none') return [];
  const floor = SEVERITY_RANK[failOn];
  return findings.filter((f) => f.confirmed && SEVERITY_RANK[f.severity] >= floor);
}

/** Convert surface-level code findings on an Observation into scrubbed Proof Core Finding records. */
export function normalizeSurfaceFindings(
  obs: Observation,
  hide: (t: string) => string,
  context: { planId?: string; stepId?: string } = {},
): Finding[] {
  if (!obs.findings?.length) return [];
  const obsUrl = hide(obs.url);
  return obs.findings.map((sf: SurfaceFinding, i: number) => {
    const safeUrl = sf.url !== undefined ? hide(sf.url) : obsUrl;
    const nodes = sf.nodes?.map((n) => ({
      ref: n.ref,
      role: n.role,
      name: hide(n.name),
      ...(n.state !== undefined ? { state: hide(n.state) } : {}),
      ...(n.testId !== undefined ? { testId: hide(n.testId) } : {}),
      box: n.box,
    }));
    return {
      id: `${sf.category}:${i + 1}`,
      category: sf.category,
      title: hide(sf.title),
      severity: sf.severity,
      source: 'code',
      confirmed: sf.confirmed,
      url: safeUrl,
      ...(context.planId ? { planId: context.planId } : {}),
      ...(context.stepId ? { stepId: context.stepId } : {}),
      evidence: hide(sf.evidence),
      ...(nodes?.length ? { nodes } : {}),
    };
  });
}

export interface Finding {
  id: string;
  category: string;
  title: string;
  severity: FindingSeverity;
  source: FindingSource;
  confirmed: boolean;
  url?: string;
  planId?: string;
  stepId?: string;
  evidence: string;
  nodes?: EvidenceNode[];
}

const INJECTION_PATTERNS: readonly { name: string; re: RegExp }[] = [
  { name: 'role-prefix', re: /(?:^|[\s"'(\[])(?:SYSTEM|DEVELOPER|ASSISTANT)\s*:/ },
  { name: 'override-instructions', re: /\b(?:ignore|disregard|forget|override)\s+(?:all\s+)?(?:previous|prior|above|earlier|system)\s+(?:instructions?|rules?|prompts?|constraints?)\b/i },
  { name: 'tool-forge', re: /\b(?:record_verdict|step_done|evidence_refs|mark\s+(?:this|all)\s+pass)\b/i },
  { name: 'fence-escape', re: /<\/?page_data\b/i },
  { name: 'verdict-command', re: /\byou\s+(?:must|should|are\s+instructed\s+to)\s+(?:always\s+)?(?:pass|approve|return\s+pass|record\s+(?:a\s+)?pass)\b/i },
  { name: 'verdict-kv', re: /\bverdict\s*[:=]\s*["']?pass["']?(?:\s|,|$)/i },
];

interface InjectionHit {
  name: string;
  match: string;
  snippet: string;
}

function snippetAt(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 16);
  const end = Math.min(text.length, index + length + 40);
  return text.slice(start, end).replace(/\s+/g, ' ').trim();
}

function findInjectionMatches(text: string): InjectionHit[] {
  if (!text) return [];
  const hits: InjectionHit[] = [];
  for (const pat of INJECTION_PATTERNS) {
    const m = pat.re.exec(text);
    if (m) hits.push({ name: pat.name, match: m[0].trim().toLowerCase(), snippet: snippetAt(text, m.index, m[0].length) });
  }
  return hits;
}

function scrubNode(n: SnapNode, hide: (t: string) => string): EvidenceNode {
  return toEvidenceNode({
    ...n,
    name: hide(n.name),
    state: hide(n.state),
    ...(n.testId ? { testId: hide(n.testId) } : {}),
  });
}

/**
 * Scan every rendered observation text surface (title, URL, node names/states, and full rendered body text)
 * for prompt-injection patterns. Returns high-severity confirmed code findings; any finding here invalidates
 * `model-only` passes on that screen.
 */
export function detectPromptInjection(
  obs: Observation,
  hide: (t: string) => string,
  context: { planId?: string; stepId?: string } = {},
): Finding[] {
  const findings: Finding[] = [];
  const seen = new Set<string>();
  const url = hide(obs.url);

  const checkSurface = (where: string, raw: string, node?: SnapNode, allMatches = false) => {
    const scrubbed = hide(raw);
    const hits = findInjectionMatches(scrubbed);
    if (hits.length === 0) return;
    let emitted = false;
    for (const hit of hits) {
      const key = `${url}|${hit.name}|${hit.match}`;
      const alreadySeen = seen.has(key);
      seen.add(key);
      if (alreadySeen || (!allMatches && emitted)) continue;
      emitted = true;
      findings.push({
        id: `prompt-injection:${findings.length + 1}`,
        category: 'prompt-injection',
        title: 'Prompt-injection text detected on page',
        severity: 'high',
        source: 'code',
        confirmed: true,
        url,
        ...(context.planId ? { planId: context.planId } : {}),
        ...(context.stepId ? { stepId: context.stepId } : {}),
        evidence: `${where} matched "${hit.snippet}"`,
        ...(node ? { nodes: [scrubNode(node, hide)] } : {}),
      });
    }
  };

  checkSurface('page title', obs.title);
  checkSurface('page URL', obs.url);
  for (const n of obs.nodes) {
    if (n.box.width <= 1 || n.box.height <= 1) continue;
    checkSurface(n.role, n.name, n);
    if (n.state) checkSurface(`${n.role} state`, n.state, n);
  }
  if (obs.renderedText) checkSurface('rendered page text', obs.renderedText, undefined, true);
  return findings;
}

/** Stable screen key so model-proposed findings run at most once per distinct rendered view. */
export function screenProposalKey(obs: Observation): string {
  const sig = obs.nodes
    .slice(0, 12)
    .map((n) => `${n.role}:${n.name}`)
    .join('|');
  return `${obs.url}\n${obs.title}\n${sig}`;
}

/** Convert model-proposed findings into scrubbed Finding records, strictly keeping confirmed: false. */
export function normalizeProposedFindings(
  proposed: readonly ProposedFinding[],
  obs: Observation,
  hide: (t: string) => string,
  context: { planId?: string; stepId?: string } = {},
): Finding[] {
  if (!proposed.length) return [];
  const obsUrl = hide(obs.url);
  return proposed.map((pf, i) => ({
    id: `${pf.category}:${i + 1}`,
    category: hide(pf.category),
    title: hide(pf.title),
    severity: pf.severity,
    source: 'model',
    confirmed: false,
    url: pf.url !== undefined ? hide(pf.url) : obsUrl,
    ...(context.planId ? { planId: context.planId } : {}),
    ...(context.stepId ? { stepId: context.stepId } : {}),
    evidence: hide(pf.evidence),
    ...(pf.nodes.length
      ? {
          nodes: pf.nodes.map((n) => ({
            ref: n.ref,
            role: n.role,
            name: hide(n.name),
            ...(n.state !== undefined ? { state: hide(n.state) } : {}),
            ...(n.testId !== undefined ? { testId: hide(n.testId) } : {}),
            box: n.box,
          })),
        }
      : {}),
  }));
}

/** Canonical deduplication signature shared by dedupeFindings and readiness evidence linking. */
export function findingDedupeKey(f: Pick<Finding, 'category' | 'severity' | 'url' | 'evidence'>): string {
  return `${f.category}|${f.severity}|${f.url ?? ''}|${f.evidence}`;
}

/** Deduplicate findings across observations/plans; model proposals stay unconfirmed unless corroborated by a code finding. */
export function dedupeFindings(list: readonly Finding[]): Finding[] {
  const confirmedCodeMaxRank = new Map<string, number>();
  for (const f of list) {
    if (f.source === 'code' && f.confirmed) {
      const key = `${f.category}|${f.url ?? ''}`;
      confirmedCodeMaxRank.set(key, Math.max(confirmedCodeMaxRank.get(key) ?? 0, SEVERITY_RANK[f.severity]));
    }
  }
  const seen = new Set<string>();
  const out: Finding[] = [];
  for (const raw of list) {
    const maxRank = confirmedCodeMaxRank.get(`${raw.category}|${raw.url ?? ''}`) ?? 0;
    const corroborated = raw.source === 'model' && !raw.confirmed && maxRank >= SEVERITY_RANK[raw.severity];
    const f = corroborated ? { ...raw, confirmed: true } : raw;
    const k = findingDedupeKey(f);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ ...f, id: `${f.category}-${out.length + 1}` });
  }
  return out;
}
