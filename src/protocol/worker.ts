// SPDX-License-Identifier: Apache-2.0
// Wire protocol and codec for external surface workers (miqyas-worker/1).

export const WORKER_PROTOCOL_VERSION = 'miqyas-worker/1' as const;

export type WorkerVerdict = 'pass' | 'fail' | 'not_checked' | 'blocked' | 'unverified';

export type WorkerExpectation = 'visible' | 'hidden' | 'enabled' | 'disabled' | 'text' | 'count';

export interface WorkerLocator {
  role?: string;
  name?: string;
  testId?: string;
  text?: string;
  css?: string;
}

export interface WorkerCheck {
  locator?: WorkerLocator;
  expect: WorkerExpectation;
  value?: string | number;
}

export interface WorkerBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WorkerTreeNode {
  ref?: string;
  role: string;
  name?: string;
  state?: string[];
  box?: WorkerBox;
}

export interface WorkerEvidence {
  crop?: string;
  node?: WorkerTreeNode;
  observation?: string;
  details?: Record<string, unknown>;
}

export type WorkerRequest =
  | { type: 'hello'; protocol: typeof WORKER_PROTOCOL_VERSION }
  | { type: 'open'; id?: string; target: string; options?: Record<string, unknown> }
  | { type: 'act'; id?: string; step_id: string; text: string; locator?: WorkerLocator; input?: string }
  | { type: 'observe'; id?: string }
  | { type: 'check'; id?: string; assertion_id: string; check?: WorkerCheck }
  | { type: 'close'; id?: string };

export type WorkerResponse =
  | { type: 'ready'; protocol?: typeof WORKER_PROTOCOL_VERSION; surface: string; capabilities: string[] }
  | { type: 'observation'; id?: string; screenshot: string; tree: WorkerTreeNode[]; url?: string; title?: string }
  | { type: 'verdict'; id?: string; assertion_id: string; verdict: WorkerVerdict; evidence?: WorkerEvidence }
  | { type: 'error'; id?: string; code: string; message: string };

export type WorkerMessage = WorkerRequest | WorkerResponse;

export class WorkerProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkerProtocolError';
  }
}

const VALID_VERDICTS = new Set<WorkerVerdict>(['pass', 'fail', 'not_checked', 'blocked', 'unverified']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(obj: Record<string, unknown>, field: string): string {
  const val = obj[field];
  if (typeof val !== 'string' || val.length === 0) {
    throw new WorkerProtocolError(`miqyas-worker/1 message field "${field}" must be a non-empty string`);
  }
  return val;
}

function parseJsonObject(line: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (err) {
    throw new WorkerProtocolError(
      `Invalid JSON line for miqyas-worker/1: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!isRecord(parsed)) {
    throw new WorkerProtocolError('miqyas-worker/1 message must be a JSON object');
  }
  if (typeof parsed.type !== 'string') {
    throw new WorkerProtocolError('miqyas-worker/1 message must include a string "type"');
  }
  return parsed;
}

export function encodeWorkerMessage(message: WorkerMessage): string {
  return `${JSON.stringify(message)}\n`;
}

export function parseWorkerRequest(line: string): WorkerRequest {
  const obj = parseJsonObject(line);
  const type = obj.type;
  switch (type) {
    case 'hello': {
      const protocol = requireString(obj, 'protocol');
      if (protocol !== WORKER_PROTOCOL_VERSION) {
        throw new WorkerProtocolError(`Unsupported worker protocol "${protocol}"; expected "${WORKER_PROTOCOL_VERSION}"`);
      }
      return { type: 'hello', protocol: WORKER_PROTOCOL_VERSION };
    }
    case 'open':
      return {
        type: 'open',
        ...(typeof obj.id === 'string' ? { id: obj.id } : {}),
        target: requireString(obj, 'target'),
        ...(isRecord(obj.options) ? { options: obj.options } : {}),
      };
    case 'act':
      return {
        type: 'act',
        ...(typeof obj.id === 'string' ? { id: obj.id } : {}),
        step_id: requireString(obj, 'step_id'),
        text: requireString(obj, 'text'),
        ...(isRecord(obj.locator) ? { locator: obj.locator as WorkerLocator } : {}),
        ...(typeof obj.input === 'string' ? { input: obj.input } : {}),
      };
    case 'observe':
      return {
        type: 'observe',
        ...(typeof obj.id === 'string' ? { id: obj.id } : {}),
      };
    case 'check':
      return {
        type: 'check',
        ...(typeof obj.id === 'string' ? { id: obj.id } : {}),
        assertion_id: requireString(obj, 'assertion_id'),
        ...(isRecord(obj.check) ? { check: obj.check as unknown as WorkerCheck } : {}),
      };
    case 'close':
      return {
        type: 'close',
        ...(typeof obj.id === 'string' ? { id: obj.id } : {}),
      };
    default:
      throw new WorkerProtocolError(`Unknown worker request type "${type}"`);
  }
}

export function parseWorkerResponse(line: string): WorkerResponse {
  const obj = parseJsonObject(line);
  const type = obj.type;
  switch (type) {
    case 'ready': {
      if (obj.protocol !== undefined && obj.protocol !== WORKER_PROTOCOL_VERSION) {
        throw new WorkerProtocolError(
          `Unsupported worker response protocol "${String(obj.protocol)}"; expected "${WORKER_PROTOCOL_VERSION}"`,
        );
      }
      if (!Array.isArray(obj.capabilities) || !obj.capabilities.every((c) => typeof c === 'string')) {
        throw new WorkerProtocolError('miqyas-worker/1 "ready" requires a string[] "capabilities" field');
      }
      return {
        type: 'ready',
        ...(obj.protocol === WORKER_PROTOCOL_VERSION ? { protocol: WORKER_PROTOCOL_VERSION } : {}),
        surface: requireString(obj, 'surface'),
        capabilities: obj.capabilities,
      };
    }
    case 'observation': {
      if (!Array.isArray(obj.tree)) {
        throw new WorkerProtocolError('miqyas-worker/1 "observation" requires a "tree" array');
      }
      return {
        type: 'observation',
        ...(typeof obj.id === 'string' ? { id: obj.id } : {}),
        screenshot: requireString(obj, 'screenshot'),
        tree: obj.tree as WorkerTreeNode[],
        ...(typeof obj.url === 'string' ? { url: obj.url } : {}),
        ...(typeof obj.title === 'string' ? { title: obj.title } : {}),
      };
    }
    case 'verdict': {
      const verdict = requireString(obj, 'verdict') as WorkerVerdict;
      if (!VALID_VERDICTS.has(verdict)) {
        throw new WorkerProtocolError(`Invalid worker verdict "${verdict}"`);
      }
      return {
        type: 'verdict',
        ...(typeof obj.id === 'string' ? { id: obj.id } : {}),
        assertion_id: requireString(obj, 'assertion_id'),
        verdict,
        ...(isRecord(obj.evidence) ? { evidence: obj.evidence as WorkerEvidence } : {}),
      };
    }
    case 'error':
      return {
        type: 'error',
        ...(typeof obj.id === 'string' ? { id: obj.id } : {}),
        code: requireString(obj, 'code'),
        message: requireString(obj, 'message'),
      };
    default:
      throw new WorkerProtocolError(`Unknown worker response type "${type}"`);
  }
}
