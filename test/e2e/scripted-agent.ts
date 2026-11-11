// SPDX-License-Identifier: PolyForm-Shield-1.0.0
// A deterministic agent for offline end-to-end tests: no model, no network. It clicks the node whose name is
// quoted in the step, and passes an assertion when every quoted text is rendered (cites those nodes).

import type { ActContext, ActOutcome, Agent, JudgeContext, JudgeOutcome } from '../../src/model/agent.js';

const quoted = (s: string) => [...s.matchAll(/'([^']+)'/g)].map((m) => m[1]!);

export class ScriptedAgent implements Agent {
  readonly info = { provider: 'scripted', model: 'none' };
  readonly usage = { calls: 0, inputTokens: 0, outputTokens: 0 };
  /** Cite a ref that doesn't exist, to exercise the unverified rule. */
  citeBogusRefs = false;

  async act(ctx: ActContext): Promise<ActOutcome> {
    const [target] = quoted(ctx.step.text);
    if (/open the app/i.test(ctx.step.text)) {
      await ctx.execute({ tool: 'navigate', path: '/' });
      return { status: 'done', summary: 'opened /' };
    }
    const node = ctx.observation.nodes.find((n) => ['button', 'link', 'radio'].includes(n.role) && n.name === target);
    if (!node) return { status: 'failed', summary: `no button, link or radio named "${target}"` };
    const r = await ctx.execute({ tool: 'click', ref: node.ref });
    return r.ok ? { status: 'done', summary: `clicked ${target}` } : { status: 'failed', summary: r.message };
  }

  async judge(ctx: JudgeContext): Promise<JudgeOutcome> {
    const wanted = quoted(ctx.step.text);
    const hits = wanted.map((w) => ctx.current.nodes.find((n) => n.name.toLowerCase().includes(w.toLowerCase())));
    const ok = hits.every(Boolean);
    const refs = this.citeBogusRefs ? ['c999e1'] : hits.filter((h) => h !== undefined).map((h) => h.ref);
    return {
      verdict: ok ? 'pass' : 'fail',
      observation: ok ? `rendered: ${wanted.join(', ')}` : `not rendered: ${wanted.filter((_, i) => !hits[i]).join(', ')}`,
      evidenceRefs: refs,
    };
  }
}
