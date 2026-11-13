// SPDX-License-Identifier: PolyForm-Shield-1.0.0
// Observation of a web page: a full-page screenshot plus a snapshot of rendered nodes only. "Visible" means
// rendered (computed style, non-zero box larger than 1×1 px, not transparent): text that is only in the markup is
// not visible (SRS FR-L5), and screen-reader-only copies are not duplicates.

import type { Page } from 'playwright';
import { PNG } from 'pngjs';
import { jsonQuote } from '../../scrub/scrub.js';
import type { Box, EvidenceNode, Observation, ObserveOptions, SnapNode } from '../session.js';

export type { Observation, ObserveOptions, SnapNode } from '../session.js';

// Runs in the page. Kept as a string so test transforms can't inject helpers into it.
const SNAPSHOT_FN = String.raw`(arg) => {
  const MAX = arg.max;
  const prefix = 'c' + arg.capture + 'e';
  for (const el of document.querySelectorAll('[data-miqyas-ref]')) el.removeAttribute('data-miqyas-ref');
  const collapse = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const cut = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
  const IMPLICIT = { A: 'link', BUTTON: 'button', SELECT: 'combobox', TEXTAREA: 'textbox', SUMMARY: 'button',
    H1: 'heading', H2: 'heading', H3: 'heading', H4: 'heading', H5: 'heading', H6: 'heading', DIALOG: 'dialog',
    NAV: 'navigation', MAIN: 'main', ASIDE: 'complementary', LI: 'listitem', IMG: 'img', PROGRESS: 'progressbar',
    LABEL: 'label', FORM: 'form', TABLE: 'table', TR: 'row', TH: 'columnheader', TD: 'cell', OPTION: 'option',
    FIELDSET: 'group', LEGEND: 'legend', UL: 'list', OL: 'list' };
  const roleOf = (el) => {
    // A role is one ARIA token, else the implicit one (Node checks it again: see fromPage()).
    const r = (el.getAttribute('role') || '').trim().split(/\s+/)[0];
    if (/^[a-z-]+$/i.test(r)) return r;
    if (el.tagName === 'A' && !el.hasAttribute('href')) return '';
    if (el.tagName === 'INPUT') {
      const t = (el.getAttribute('type') || 'text').toLowerCase();
      if (t === 'hidden') return '';
      if (t === 'checkbox') return 'checkbox';
      if (t === 'radio') return 'radio';
      if (t === 'range') return 'slider';
      if (t === 'button' || t === 'submit' || t === 'reset') return 'button';
      return 'textbox';
    }
    return IMPLICIT[el.tagName] || '';
  };
  const textOf = (el) => collapse(el.innerText || el.textContent || '');
  const nameOf = (el, role) => {
    const al = el.getAttribute('aria-label');
    if (al) return collapse(al);
    const lb = el.getAttribute('aria-labelledby');
    if (lb) {
      const t = lb.split(/\s+/).map((id) => document.getElementById(id)).filter(Boolean).map(textOf).join(' ');
      if (t) return collapse(t);
    }
    if (el.labels && el.labels.length) return textOf(el.labels[0]);
    if (el.tagName === 'IMG') return collapse(el.getAttribute('alt') || '');
    if (role === 'textbox' || role === 'combobox') return collapse(el.getAttribute('placeholder') || el.getAttribute('title') || '');
    const containers = ['listitem', 'list', 'navigation', 'main', 'complementary', 'form', 'table', 'row', 'group', 'dialog', 'region'];
    if (containers.includes(role)) {
      const h = el.querySelector('h1,h2,h3,h4,h5,h6,legend,[role=heading]');
      return h ? cut(textOf(h), 60) : '';
    }
    return cut(textOf(el), 120) || collapse(el.getAttribute('title') || '');
  };
  const visible = (el) => {
    if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    const r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1;
  };
  const stateOf = (el, role) => {
    // Fields, not text: Node builds the state string (stateText), since the page can redefine anything used here.
    const s = {};
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') s.disabled = true;
    if ((role === 'checkbox' || role === 'radio' || role === 'switch') && (el.checked || el.getAttribute('aria-checked') === 'true')) s.checked = true;
    for (const a of ['pressed', 'selected', 'expanded', 'current', 'invalid']) {
      const v = el.getAttribute('aria-' + a);
      if (v && v !== 'false') s[a] = v === 'true' ? true : v;
    }
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      const t = (el.getAttribute('type') || '').toLowerCase();
      // Bounded, not cut for the prompt: Node scrubs secrets from the whole value first, then cuts (stateText).
      if (role === 'textbox') s.value = t === 'password' ? '•'.repeat(Math.min(el.value.length, 80)) : cut(el.value, 4096);
    }
    if (el.tagName === 'SELECT') {
      const o = el.selectedOptions[0];
      s.option = o ? collapse(o.text) : '';
      s.options = [...el.options].slice(0, 20).map((x) => collapse(x.text));
    }
    if (el.tagName === 'H1' || el.tagName === 'H2' || el.tagName === 'H3' || el.tagName === 'H4' || el.tagName === 'H5' || el.tagName === 'H6') s.level = Number(el.tagName[1]);
    return s;
  };
  const INTERACTIVE = new Set(['button', 'link', 'textbox', 'checkbox', 'radio', 'combobox', 'slider', 'switch', 'tab', 'menuitem', 'option', 'searchbox', 'spinbutton']);
  const ALWAYS = new Set(['heading', 'dialog', 'alertdialog', 'alert', 'status', 'navigation', 'main', 'complementary', 'listitem', 'img', 'progressbar', 'tabpanel', 'region', 'table', 'row', 'cell', 'columnheader', 'group', 'legend', 'label', 'tablist', 'menu', 'list', 'form']);
  const out = [];
  let n = 0;
  let truncated = false;
  const sx = window.scrollX, sy = window.scrollY;
  const walk = (el, depth) => {
    if (out.length >= MAX) { truncated = true; return; }
    if (!(el instanceof HTMLElement || el instanceof SVGElement)) return;
    const tag = el.tagName;
    if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEMPLATE') return;
    let childDepth = depth;
    if (el instanceof HTMLElement) {
      const role = roleOf(el);
      const directText = collapse([...el.childNodes].filter((c) => c.nodeType === 3).map((c) => c.textContent).join(' '));
      const include = INTERACTIVE.has(role) || ALWAYS.has(role) || el.isContentEditable || (el.tabIndex >= 0 && el.hasAttribute('tabindex')) || directText.length > 0;
      if (include && visible(el)) {
        const r = el.getBoundingClientRect();
        const finalRole = role || (directText ? 'text' : 'generic');
        const ref = prefix + (++n);
        el.setAttribute('data-miqyas-ref', ref);
        const name = finalRole === 'text' ? cut(directText, 160) : nameOf(el, finalRole);
        out.push({ ref, role: finalRole, name, depth, state: stateOf(el, finalRole),
          box: { x: Math.round(r.left + sx), y: Math.round(r.top + sy), width: Math.round(r.width), height: Math.round(r.height) } });
        childDepth = depth + 1;
        // Leaf controls: their text is their name.
        if (INTERACTIVE.has(finalRole) && finalRole !== 'option') return;
      }
    }
    for (const c of el.children) walk(c, childDepth);
  };
  walk(document.body, 0);
  const de = document.documentElement;
  return { nodes: out, truncated, url: location.href, title: document.title, lang: de.getAttribute('lang') || '', dir: de.getAttribute('dir') || getComputedStyle(document.body).direction,
    bodyDirection: getComputedStyle(document.body).direction, viewport: { width: innerWidth, height: innerHeight } };
}`;

// Runs in each frame just before the screenshot: paints over secret values so the pixels don't carry them, without
// touching what the app reads. Values are never set and no event fires. Fields (any input but a password, which
// already shows dots; a textarea; a contenteditable root) whose value holds a secret get a temporary attribute; text
// nodes holding one get a Range in a CSS custom highlight, so no element is added or split. One constructed sheet,
// adopted by each document or open shadow root involved (no <style> node), turns the marked fields' text transparent
// on a solid background and the highlighted ranges into solid boxes; neither changes layout. The undo, kept under a
// symbol on window, drops the attribute, the sheet and the highlight right after capture. A canvas or embed can't be
// read, so it is counted, not guessed at: the return value is how many there are.
const MASK_FN = String.raw`(arg) => {
  const KEY = Symbol.for('miqyas.unmask');
  if (window[KEY]) window[KEY]();
  const one = new RegExp(arg.source, arg.flags);
  const all = new RegExp(arg.source, arg.flags + 'g');
  const marked = [];
  const ranges = [];
  const roots = new Set();
  let blind = 0;
  const visit = (root) => {
    const w = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      if (n.nodeType === 3) {
        for (const m of n.data.matchAll(all)) {
          const r = new Range();
          r.setStart(n, m.index);
          r.setEnd(n, m.index + m[0].length);
          ranges.push(r);
          roots.add(n.getRootNode());
        }
        continue;
      }
      const tag = n.tagName;
      const field = (tag === 'INPUT' && n.type !== 'password') || tag === 'TEXTAREA';
      const editable = n.isContentEditable && !(n.parentElement && n.parentElement.isContentEditable);
      if ((field && one.test(n.value)) || (editable && one.test(n.textContent || ''))) {
        n.setAttribute('data-miqyas-mask', '');
        marked.push(n);
        roots.add(n.getRootNode());
      }
      if ((tag === 'CANVAS' || tag === 'EMBED' || tag === 'OBJECT') && n.checkVisibility()) blind++;
      if (n.shadowRoot) visit(n.shadowRoot);
    }
  };
  visit(document);
  if (marked.length || ranges.length) {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync([
      '[data-miqyas-mask], [data-miqyas-mask] *, [data-miqyas-mask]::selection, [data-miqyas-mask] *::selection',
      '{ color: transparent !important; -webkit-text-fill-color: transparent !important; text-shadow: none !important; }',
      '[data-miqyas-mask] { background: #000 !important; }',
      // Transparent glyphs, not black ones: ink that overhangs the box (a W's edge) would still trace the letters.
      '::highlight(miqyas-mask) { color: transparent; -webkit-text-fill-color: transparent; background-color: #000; text-shadow: none; }',
    ].join('\n'));
    for (const r of roots) r.adoptedStyleSheets = [...r.adoptedStyleSheets, sheet];
    if (ranges.length) CSS.highlights.set('miqyas-mask', new Highlight(...ranges));
    window[KEY] = () => {
      for (const el of marked) el.removeAttribute('data-miqyas-mask');
      for (const r of roots) r.adoptedStyleSheets = r.adoptedStyleSheets.filter((s) => s !== sheet);
      CSS.highlights.delete('miqyas-mask');
      delete window[KEY];
    };
  }
  return blind;
}`;
const UNMASK = `window[Symbol.for('miqyas.unmask')]?.()`;

/** Masks secrets in every frame; returns how many surfaces could not be checked (a frame that can't be read counts). */
async function maskSecrets(page: Page, secrets: RegExp): Promise<number> {
  const arg = JSON.stringify({ source: secrets.source, flags: secrets.flags });
  const blind = await Promise.all(page.frames().map((f) => f.evaluate(`(${MASK_FN})(${arg})`).then((n) => n as number, () => 1)));
  return blind.reduce((a, b) => a + b, 0);
}

const ARIA_ROLES = new Set([
  'button', 'link', 'textbox', 'checkbox', 'radio', 'combobox', 'slider', 'switch', 'tab', 'menuitem', 'option', 'heading',
  'dialog', 'alertdialog', 'alert', 'status', 'navigation', 'main', 'complementary', 'listitem', 'img', 'progressbar',
  'tabpanel', 'region', 'table', 'row', 'cell', 'columnheader', 'group', 'tablist', 'menu', 'list', 'form', 'searchbox', 'spinbutton',
]);

function q(s: string): string {
  return `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/** A Playwright locator by role and accessible name, or by text. Never positional. */
export function locatorFor(role: string, name: string): string {
  if (ARIA_ROLES.has(role) && name) return `getByRole(${q(role)}, { name: ${q(name)} })`;
  if (ARIA_ROLES.has(role)) return `getByRole(${q(role)})`;
  if (name) return `getByText(${q(name)})`;
  return '';
}

let captureCounter = 0;

// What the in-page function returns is untrusted: the page can redefine JSON.stringify, RegExp.prototype.test,
// String.prototype.trim, Array.prototype.push… before it runs, so every field is checked again here, in Node.
const str = (v: unknown, max = 2000) => (typeof v === 'string' ? v.slice(0, max) : '');
const int = (v: unknown, lo: number, hi: number) => (Number.isInteger(v) ? Math.min(hi, Math.max(lo, v as number)) : 0);
const obj = (v: unknown) => (v !== null && typeof v === 'object' ? v : {}) as Record<string, unknown>;
const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const ARIA_STATES = ['pressed', 'selected', 'expanded', 'current', 'invalid'] as const;

/** The state as text, built here from the page's fields, with every page value quoted by Node. */
function stateText(v: unknown, hide: (t: string) => string): string {
  const f = obj(v);
  const s: string[] = [];
  if (f.disabled === true) s.push('disabled');
  if (f.checked === true) s.push('checked');
  for (const a of ARIA_STATES) if (f[a] === true) s.push(a); else if (typeof f[a] === 'string' && f[a]) s.push(`${a}=${jsonQuote(str(f[a], 200))}`);
  // A cut before the scrub would leave a long secret's prefix, which the whole-value scrub never matches.
  if (typeof f.value === 'string') s.push(`value=${jsonQuote(cut(hide(str(f.value, 4096)), 80))}`);
  if (typeof f.option === 'string') s.push(`selected=${jsonQuote(str(f.option, 200))}`);
  if (Array.isArray(f.options)) s.push(`options=${f.options.slice(0, 20).map((o) => jsonQuote(str(o, 200))).join(',')}`);
  if (Number.isInteger(f.level) && (f.level as number) >= 1 && (f.level as number) <= 6) s.push(`level=${f.level}`);
  return s.join(' ');
}

function fromPage(raw: unknown, capture: number, hide: (t: string) => string) {
  const r = obj(raw);
  const refOk = new RegExp(`^c${capture}e\\d{1,6}$`);
  const nodes: Omit<SnapNode, 'locator'>[] = [];
  const seen = new Set<string>();
  for (const n of Array.isArray(r.nodes) ? (r.nodes as Record<string, unknown>[]).slice(0, 5000) : []) {
    // A ref the runner didn't mint, or one seen already, could pose as another node: drop the node.
    if (n === null || typeof n !== 'object' || typeof n.ref !== 'string' || !refOk.test(n.ref) || seen.has(n.ref)) continue;
    seen.add(n.ref);
    const role = str(n.role, 40).toLowerCase();
    const b = obj(n.box);
    nodes.push({
      ref: n.ref,
      role: /^[a-z-]+$/.test(role) ? role : 'generic',
      name: str(n.name, 500),
      depth: int(n.depth, 0, 100),
      box: { x: int(b.x, -1e6, 1e6), y: int(b.y, -1e6, 1e6), width: int(b.width, 0, 1e6), height: int(b.height, 0, 1e6) },
      state: stateText(n.state, hide),
    });
  }
  const vp = obj(r.viewport);
  return { nodes, truncated: r.truncated === true, url: str(r.url), title: str(r.title, 500), lang: str(r.lang, 40), dir: str(r.dir, 10), viewport: { width: int(vp.width, 0, 1e5), height: int(vp.height, 0, 1e5) } };
}

export async function observe(page: Page, opts: ObserveOptions = {}): Promise<Observation> {
  const capture = ++captureCounter;
  const raw = fromPage(await page.evaluate(`(${SNAPSHOT_FN})(${JSON.stringify({ capture, max: opts.maxNodes ?? 700 })})`), capture, opts.hide ?? ((t) => t));
  const blind = opts.secrets ? await maskSecrets(page, opts.secrets) : 0;
  let png: Buffer;
  try {
    png = await page.screenshot({ fullPage: true, type: 'png', animations: 'disabled', caret: 'hide' });
  } finally {
    if (opts.secrets) await Promise.all(page.frames().map((f) => f.evaluate(UNMASK).catch(() => {})));
  }
  return {
    capture,
    url: raw.url,
    title: raw.title,
    lang: raw.lang,
    dir: raw.dir,
    viewport: raw.viewport,
    nodes: raw.nodes.map((n) => ({ ...n, locator: locatorFor(n.role, n.name) })),
    truncated: raw.truncated,
    png,
    capturedAt: new Date(),
    ...(blind ? { unmasked: `screenshot may show an unmasked secret: ${blind} canvas, embed or frame not checked` } : {}),
  };
}

/** The snapshot as text for the model: one line per rendered node, indented by nesting. Page text (url, title, lang,
 * dir, names, and the values in a state) is written as JSON strings, so it can't end its field or its line. */
export function snapshotText(o: Observation): string {
  const head = `capture ${o.capture} · ${jsonQuote(o.url)} · title ${jsonQuote(o.title)} · lang=${jsonQuote(o.lang)} dir=${jsonQuote(o.dir)} · viewport ${o.viewport.width}x${o.viewport.height}`;
  const lines = o.nodes.map((n) => {
    const b = n.box;
    return `${'  '.repeat(Math.min(n.depth, 12))}${n.ref} ${n.role}${n.name ? ` ${jsonQuote(n.name)}` : ''}${n.state ? ` [${n.state}]` : ''} @${b.x},${b.y} ${b.width}x${b.height}`;
  });
  if (o.truncated) lines.push('(snapshot truncated)');
  return [head, ...lines].join('\n');
}

export function toEvidenceNode(n: SnapNode): EvidenceNode {
  const e: EvidenceNode = { ref: n.ref, role: n.role, name: n.name, box: n.box };
  if (n.state) e.state = n.state;
  return e;
}

/** Crop the union of `boxes` (padded) out of a full-page PNG. */
export function cropPng(png: Buffer, boxes: Box[], pad = 12): Buffer | undefined {
  if (boxes.length === 0) return undefined;
  const img = PNG.sync.read(png);
  const x0 = Math.max(0, Math.floor(Math.min(...boxes.map((b) => b.x)) - pad));
  const y0 = Math.max(0, Math.floor(Math.min(...boxes.map((b) => b.y)) - pad));
  const x1 = Math.min(img.width, Math.ceil(Math.max(...boxes.map((b) => b.x + b.width)) + pad));
  const y1 = Math.min(img.height, Math.ceil(Math.max(...boxes.map((b) => b.y + b.height)) + pad));
  if (x1 <= x0 || y1 <= y0) return undefined;
  const out = new PNG({ width: x1 - x0, height: y1 - y0 });
  PNG.bitblt(img, out, x0, y0, x1 - x0, y1 - y0, 0, 0);
  return PNG.sync.write(out);
}
