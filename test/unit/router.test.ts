// SPDX-License-Identifier: PolyForm-Shield-1.0.0
// Route, endpoint, credential, and local/private host resolution tests (issue #10).

import { describe, expect, it } from 'vitest';
import { isLocalOrPrivateHost, sanitizeEndpointUrl } from '../../src/agents/models.js';
import { resolveRoute, RouteEnvError, RouteUsageError } from '../../src/agents/router.js';

describe('local/private host classification and URL sanitization', () => {
  it('recognizes loopback and RFC1918/ULA hosts while rejecting public and link-local metadata hosts', () => {
    expect(isLocalOrPrivateHost('127.0.0.1')).toBe(true);
    expect(isLocalOrPrivateHost('localhost')).toBe(true);
    expect(isLocalOrPrivateHost('ollama.localhost')).toBe(true);
    expect(isLocalOrPrivateHost('[::1]')).toBe(true);
    expect(isLocalOrPrivateHost('::1')).toBe(true);
    expect(isLocalOrPrivateHost('10.20.30.40')).toBe(true);
    expect(isLocalOrPrivateHost('172.16.0.1')).toBe(true);
    expect(isLocalOrPrivateHost('172.31.255.254')).toBe(true);
    expect(isLocalOrPrivateHost('192.168.1.50')).toBe(true);
    expect(isLocalOrPrivateHost('fd12:3456:789a::1')).toBe(true);
    expect(isLocalOrPrivateHost('vllm.internal')).toBe(true);

    expect(isLocalOrPrivateHost('172.15.255.255')).toBe(false);
    expect(isLocalOrPrivateHost('172.32.0.1')).toBe(false);
    expect(isLocalOrPrivateHost('169.254.169.254')).toBe(false);
    expect(isLocalOrPrivateHost('api.anthropic.com')).toBe(false);
    expect(isLocalOrPrivateHost('api.openai.com')).toBe(false);
    expect(isLocalOrPrivateHost('llm-proxy.example.com')).toBe(false);
  });

  it('strips embedded credentials from URLs and rejects non-http(s) schemes', () => {
    const clean = sanitizeEndpointUrl('http://user:secret@127.0.0.1:11434/v1/');
    expect(clean.endpoint).toBe('http://127.0.0.1:11434/v1');
    expect(clean.host).toBe('127.0.0.1:11434');
    expect(() => sanitizeEndpointUrl('file:///etc/passwd')).toThrow();
    expect(() => sanitizeEndpointUrl('not a url')).toThrow();
  });
});

describe('resolveRoute', () => {
  it('defaults to Anthropic with low tier and requires credentials', () => {
    const route = resolveRoute({ env: {} });
    expect(route.provider).toBe('anthropic');
    expect(route.model).toBe('claude-haiku-5-5');
    expect(route.tier).toBe('low');
    expect(route.endpoint).toBe('https://api.anthropic.com');
    expect(route.customEndpoint).toBe(false);
    expect(route.billed).toBe(true);
    expect(route.requiresCredentials).toBe(true);
    expect(route.hasCredentials).toBe(false);
  });

  it('auto-selects OpenAI-compatible provider when OPENAI_BASE_URL is set on local/private host without requiring API key', () => {
    const route = resolveRoute({
      model: 'qwen2.5-vl:7b',
      env: { OPENAI_BASE_URL: 'http://127.0.0.1:11434/v1' },
    });
    expect(route.provider).toBe('openai');
    expect(route.model).toBe('qwen2.5-vl:7b');
    expect(route.endpoint).toBe('http://127.0.0.1:11434/v1');
    expect(route.endpointHost).toBe('127.0.0.1:11434');
    expect(route.customEndpoint).toBe(true);
    expect(route.localPrivate).toBe(true);
    expect(route.billed).toBe(false);
    expect(route.requiresCredentials).toBe(false);
    expect(route.hasCredentials).toBe(true);
  });

  it('requires OPENAI_API_KEY and marks run billed when OpenAI-compatible endpoint is public', () => {
    const routeNoKey = resolveRoute({
      provider: 'openai',
      endpoint: 'https://llm.example.com/v1',
      model: 'Qwen/Qwen2.5-VL-72B',
      env: {},
    });
    expect(routeNoKey.localPrivate).toBe(false);
    expect(routeNoKey.billed).toBe(true);
    expect(routeNoKey.requiresCredentials).toBe(true);
    expect(routeNoKey.hasCredentials).toBe(false);

    const routeWithKey = resolveRoute({
      provider: 'openai',
      endpoint: 'https://llm.example.com/v1',
      model: 'Qwen/Qwen2.5-VL-72B',
      env: { OPENAI_API_KEY: 'sk-test' },
    });
    expect(routeWithKey.hasCredentials).toBe(true);
    expect(routeWithKey.apiKey).toBe('sk-test');
  });

  it('rejects invalid provider or tier-without-model on OpenAI-compatible endpoints and surfaces missing endpoint cleanly', () => {
    expect(() => resolveRoute({ provider: 'bedrock', env: {} })).toThrow(RouteUsageError);
    expect(() => resolveRoute({ provider: '', env: {} })).toThrow(RouteUsageError);
    expect(() => resolveRoute({ env: { MIQYAS_PROVIDER: 'bedrock' } })).toThrow(RouteEnvError);
    expect(() => resolveRoute({ provider: 'openai', endpoint: '   ', env: { OPENAI_BASE_URL: 'ftp://bad' } })).toThrow(RouteEnvError);
    expect(() =>
      resolveRoute({ provider: 'openai', endpoint: 'http://127.0.0.1:11434/v1', tier: 'high', env: {} }),
    ).toThrow(RouteUsageError);

    const doctorUnconfigured = resolveRoute({ provider: 'openai', env: {} });
    expect(doctorUnconfigured.provider).toBe('openai');
    expect(doctorUnconfigured.endpoint).toBeNull();
    expect(() =>
      resolveRoute({ provider: 'openai', env: {}, requireReady: true }),
    ).toThrow(RouteEnvError);
  });
});
