// SPDX-License-Identifier: AGPL-3.0-only
// Adapter seam (ADR 0005): external runners, scanners, and analyzers plug into Proof Core behind this contract.

export interface AdapterFinding {
  id: string;
  title: string;
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  summary: string;
  source?: string;
}

export interface AdapterContext {
  surface: string;
  url: string;
  runDir: string;
  buildDir?: string;
  signal?: AbortSignal;
}

export interface AdapterResult {
  adapterId: string;
  version?: string;
  coverage?: string;
  status: 'ok' | 'skipped' | 'error';
  findings: AdapterFinding[];
  detail?: string;
  error?: string;
}

export interface Adapter {
  readonly id: string;
  readonly version?: string;
  readonly kind: 'scanner' | 'runner' | 'source';
  readonly surfaces: readonly string[];
  run(ctx: AdapterContext): Promise<AdapterResult>;
}

/** Run registered adapters for the active surface, isolating individual adapter failures into error entries. */
export async function runAdapters(adapters: readonly Adapter[], ctx: AdapterContext): Promise<AdapterResult[]> {
  const out: AdapterResult[] = [];
  for (const adapter of adapters) {
    if (adapter.surfaces.length && !adapter.surfaces.includes(ctx.surface)) {
      out.push({ adapterId: adapter.id, status: 'skipped', findings: [], detail: `surface ${ctx.surface} not supported` });
      continue;
    }
    try {
      out.push(await adapter.run(ctx));
    } catch (e) {
      out.push({ adapterId: adapter.id, status: 'error', error: (e as Error).message.split('\n')[0]!, findings: [] });
    }
  }
  return out;
}
