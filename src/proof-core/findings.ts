// SPDX-License-Identifier: PolyForm-Shield-1.0.0
// Security & quality findings collected outside the assertion ledger (Layer 3: proof-core).
// Includes always-on prompt-injection detection on rendered page content (#12) and shared Finding model for detectors (#13).

import type { EvidenceNode, Observation, SnapNode } from '../surfaces/session.js';
import { toEvidenceNode } from '../surfaces/web/observe.js';

export type FindingSeverity = 'info' | 'low' | 'medium' | 'high' | 'critical';
export type FindingSource = 'code' | 'model';

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

/** Deduplicate findings across observations/plans by category, severity, URL, and scrubbed evidence. */
export function dedupeFindings(list: readonly Finding[]): Finding[] {
  const seen = new Set<string>();
  const out: Finding[] = [];
  for (const f of list) {
    const k = `${f.category}|${f.severity}|${f.url ?? ''}|${f.evidence}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ ...f, id: `${f.category}-${out.length + 1}` });
  }
  return out;
}
