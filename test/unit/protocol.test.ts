// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
  WORKER_PROTOCOL_VERSION,
  WorkerProtocolError,
  encodeWorkerMessage,
  parseWorkerRequest,
  parseWorkerResponse,
  type WorkerRequest,
  type WorkerResponse,
} from '../../src/protocol/worker.js';

describe('miqyas-worker/1 protocol codec', () => {
  it('round-trips every core-to-worker request over JSON lines', () => {
    const requests: WorkerRequest[] = [
      { type: 'hello', protocol: WORKER_PROTOCOL_VERSION },
      { type: 'open', id: '1', target: 'https://example.test' },
      { type: 'act', id: '2', step_id: 's1', text: 'Click Submit', locator: { role: 'button', name: 'Submit' } },
      { type: 'observe', id: '3' },
      { type: 'check', id: '4', assertion_id: 'a1', check: { locator: { role: 'alert' }, expect: 'visible' } },
      { type: 'close', id: '5' },
    ];

    for (const req of requests) {
      const encoded = encodeWorkerMessage(req);
      expect(encoded.endsWith('\n')).toBe(true);
      expect(parseWorkerRequest(encoded.trimEnd())).toEqual(req);
    }
  });

  it('round-trips every worker-to-core response over JSON lines', () => {
    const responses: WorkerResponse[] = [
      { type: 'ready', protocol: WORKER_PROTOCOL_VERSION, surface: 'web', capabilities: ['observe', 'check'] },
      {
        type: 'observation',
        id: '3',
        screenshot: '.miqyas/run/step-3.png',
        tree: [{ ref: 'n1', role: 'button', name: 'Submit' }],
      },
      { type: 'verdict', id: '4', assertion_id: 'a1', verdict: 'pass', evidence: { crop: '.miqyas/run/crop-4.png' } },
      { type: 'error', id: '4', code: 'TIMEOUT', message: 'Timed out waiting for alert' },
    ];

    for (const res of responses) {
      const encoded = encodeWorkerMessage(res);
      expect(parseWorkerResponse(encoded.trimEnd())).toEqual(res);
    }
  });

  it('rejects unsupported protocol versions and malformed payloads', () => {
    expect(() => parseWorkerRequest('{"type":"hello","protocol":"miqyas-worker/99"}')).toThrow(WorkerProtocolError);
    expect(() => parseWorkerRequest('{"type":"open"}')).toThrow(WorkerProtocolError);
    expect(() => parseWorkerResponse('{"type":"verdict","assertion_id":"a1","verdict":"maybe"}')).toThrow(
      WorkerProtocolError,
    );
    expect(() => parseWorkerResponse('not json')).toThrow(WorkerProtocolError);
  });
});
