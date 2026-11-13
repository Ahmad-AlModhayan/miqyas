// SPDX-License-Identifier: PolyForm-Shield-1.0.0
// Surface contracts: the one-way boundary between Proof Core / Agents and any surface driver (web, desktop, CLI, API).

/** Element geometry in CSS pixels, rounded at capture time. */
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Observed UI element recorded in evidence artifacts and surface snapshots. */
export interface EvidenceNode {
  ref: string;
  role: string;
  name: string;
  state?: string;
  testId?: string;
  box: Box;
}

/** Deterministic target selector used by code checks without invoking the model. */
export interface Locator {
  role?: string;
  name?: string;
  text?: string;
  label?: string;
  testId?: string;
}

/** Deterministic assertion specification evaluated directly by a surface session. */
export interface Check {
  locator: Locator;
  expect: 'visible' | 'hidden' | { text: string } | { count: number };
}

/**
 * Effectiveness probe run before executing mutation checks (SRS FR-M2). Kept as a neutral surface contract
 * so surface drivers can measure builds without importing Proof Core.
 */
export interface Probe {
  path?: string;
  steps?: string[];
  rootAttrs?: Record<string, string>;
  html?: string;
  measure: 'height' | 'left' | 'text';
  /** Element selector to measure (`height`, `left`). */
  selector?: string;
}

/** What a probe reads on a served build: px for `height` and `left`, null when absent, rendered text for `text`. */
export type Reading = number | string | null;

export interface SnapNode {
  ref: string;
  role: string;
  name: string;
  depth: number;
  box: Box;
  state: string;
  /** Surface locator expression by role and accessible name (or text), for exports and action logs. */
  locator: string;
  /** Optional `data-testid` attribute captured at snapshot time (bounded, scrubbed). */
  testId?: string;
}

export interface Observation {
  capture: number;
  url: string;
  title: string;
  lang: string;
  dir: string;
  viewport: { width: number; height: number };
  nodes: SnapNode[];
  truncated: boolean;
  png: Buffer;
  capturedAt: Date;
  /** Full rendered page text (scrubbed/bounded) scanned by Proof Core detectors so truncated nodes cannot hide injections. */
  renderedText?: string;
  /** Always-on code detector findings captured on this observed screen. */
  findings?: SurfaceFinding[];
  /** Set when the screenshot may show a secret that could not be masked (a canvas, embed, or unreadable frame). */
  unmasked?: string;
}

export type SurfaceFindingSeverity = 'info' | 'low' | 'medium' | 'high' | 'critical';

export interface SurfaceFinding {
  category: string;
  title: string;
  severity: SurfaceFindingSeverity;
  confirmed: boolean;
  url?: string;
  evidence: string;
  nodes?: EvidenceNode[];
}

export interface ObserveOptions {
  maxNodes?: number;
  /** Secret values (see `anyTerm`) to mask on the page before the screenshot. */
  secrets?: RegExp;
  /** Scrubs secret values from a textbox's whole value before truncating. */
  hide?: (t: string) => string;
}

export type ActTool =
  | { tool: 'click'; ref: string }
  | { tool: 'fill'; ref: string; text: string }
  | { tool: 'select_option'; ref: string; option: string }
  | { tool: 'press'; key: string }
  | { tool: 'scroll'; direction: 'up' | 'down'; ref?: string }
  | { tool: 'wait'; seconds: number }
  | { tool: 'navigate'; path: string };

export interface SurfaceActionResult {
  ok: boolean;
  message: string;
  observation: Observation;
  locator?: string;
  error?: string;
  unmasked?: string;
}

export interface SurfaceCheckResult {
  pass: boolean;
  observation: string;
  nodes: SnapNode[];
}

export interface SurfaceSessionOptions {
  url: string;
  allowOtherOrigins?: boolean;
  viewport?: { width: number; height: number };
  navTimeoutMs?: number;
  actionTimeoutMs?: number;
  observe?: ObserveOptions;
  hide?: (text: string) => string;
}

/** Isolated verification session on a single surface target (one context/page per plan). */
export interface SurfaceSession {
  observe(): Promise<Observation>;
  act(action: ActTool, resolveText?: (raw: string) => string): Promise<SurfaceActionResult>;
  check(check: Check, latest: Observation): Promise<SurfaceCheckResult>;
  wait(seconds: number): Promise<Observation>;
  close(): Promise<void>;
}

export interface CrawlOptions {
  url: string;
  maxScreens?: number;
  maxDepth?: number;
  maxRps?: number;
  viewport?: { width: number; height: number };
  hide?: (text: string) => string;
  knownSecrets?: RegExp;
  navTimeoutMs?: number;
  actionTimeoutMs?: number;
  onScreen?: (observation: Observation) => Promise<void> | void;
}

export interface CrawlScreen {
  url: string;
  depth: number;
  title: string;
  trigger?: string;
  observation: Observation;
}

export interface CrawlResult {
  screens: CrawlScreen[];
  skippedControls: number;
  skippedOffOriginLinks: number;
  haltedReason?: 'http-429' | 'http-503' | 'captcha-or-waf' | 'max-screens';
}

/** Pluggable surface driver (Web/Playwright, future CLI, desktop, API, industrial workers). */
export interface SurfaceDriver {
  readonly surface: string;
  readonly version: string | null;
  readonly defaults?: {
    viewport: { width: number; height: number };
    planTimeoutMs: number;
    navTimeoutMs: number;
    actionTimeoutMs: number;
  };
  openSession(opts: SurfaceSessionOptions): Promise<SurfaceSession>;
  crawl?(opts: CrawlOptions): Promise<CrawlResult>;
  measureProbe?(url: string, probe: Probe): Promise<Reading>;
  close(): Promise<void>;
}
