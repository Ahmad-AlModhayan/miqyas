// SPDX-License-Identifier: PolyForm-Shield-1.0.0
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  HostPolicyError,
  assertPlanUploadAllowed,
  hasCaptchaOrWafSignal,
  isAllowedConnectHostPort,
  isAllowedRequestUrl,
  isAllowedWebSocketUrl,
  isDestructiveControl,
  isTestHost,
  resolveOrCreateHostToken,
  verifyHostOwnership,
} from '../../src/surfaces/web/policy.js';

describe('shared origin and host policy', () => {
  let spendDir = '';

  beforeEach(async () => {
    spendDir = await mkdtemp(path.join(os.tmpdir(), 'miqyas-policy-'));
  });

  afterEach(async () => {
    await rm(spendDir, { recursive: true, force: true });
  });

  it('enforces one same-origin policy for HTTP, data/blob, WebSockets, and CONNECT tunnels', () => {
    const allowed = 'http://127.0.0.1:4173';
    expect(isAllowedRequestUrl('http://127.0.0.1:4173/api/items', allowed)).toBe(true);
    expect(isAllowedRequestUrl('data:text/plain;base64,SGk=', allowed)).toBe(true);
    expect(isAllowedRequestUrl('blob:http://127.0.0.1:4173/abc', allowed)).toBe(true);
    expect(isAllowedRequestUrl('blob:https://evil.example/abc', allowed)).toBe(false);
    expect(isAllowedRequestUrl('http://127.0.0.1:9999/', allowed)).toBe(false);
    expect(isAllowedRequestUrl('https://other.example/x.js', allowed)).toBe(false);
    expect(isAllowedRequestUrl('javascript:alert(1)', allowed)).toBe(false);

    expect(isAllowedWebSocketUrl('ws://127.0.0.1:4173/ws', allowed)).toBe(true);
    expect(isAllowedWebSocketUrl('wss://127.0.0.1:4173/ws', allowed)).toBe(false);
    expect(isAllowedWebSocketUrl('ws://evil.example:4173/ws', allowed)).toBe(false);
    expect(isAllowedWebSocketUrl('wss://app.example/ws', 'https://app.example')).toBe(true);

    expect(isAllowedConnectHostPort('127.0.0.1:4173', allowed)).toBe(true);
    expect(isAllowedConnectHostPort('127.0.0.1:8080', allowed)).toBe(false);
    expect(isAllowedConnectHostPort('app.example:443', 'https://app.example')).toBe(true);
    expect(isAllowedConnectHostPort('app.example:80', 'https://app.example')).toBe(false);
  });

  it('distinguishes test hosts from public and link-local metadata hosts', () => {
    expect(isTestHost('localhost')).toBe(true);
    expect(isTestHost('app.localhost')).toBe(true);
    expect(isTestHost('127.0.0.1')).toBe(true);
    expect(isTestHost('[::1]')).toBe(true);
    expect(isTestHost('fixture.test')).toBe(true);
    expect(isTestHost('10.0.0.5')).toBe(true);
    expect(isTestHost('192.168.1.20')).toBe(true);

    expect(isTestHost('169.254.169.254')).toBe(false);
    expect(isTestHost('app.example')).toBe(false);
    expect(isTestHost('staging.victim.example')).toBe(false);
  });

  it('allows passive checks anywhere, allows active checks on test hosts with --active, and blocks active checks off test hosts without consent + token', async () => {
    await expect(
      verifyHostOwnership({
        url: 'https://app.example',
        active: false,
        allowWrites: false,
        probeKind: 'passive',
        spendDir,
      }),
    ).resolves.toMatchObject({ classification: 'public-passive' });

    await expect(
      verifyHostOwnership({
        url: 'http://127.0.0.1:3000',
        active: true,
        allowWrites: false,
        probeKind: 'active-read',
        spendDir,
      }),
    ).resolves.toMatchObject({ classification: 'test-host' });

    // Missing --active
    await expect(
      verifyHostOwnership({
        url: 'http://127.0.0.1:3000',
        active: false,
        allowWrites: false,
        probeKind: 'active-read',
        spendDir,
      }),
    ).rejects.toThrow(HostPolicyError);

    // Non-test host without --allow-host
    await expect(
      verifyHostOwnership({
        url: 'https://victim.example',
        active: true,
        allowWrites: false,
        probeKind: 'active-read',
        spendDir,
      }),
    ).rejects.toThrow(/--allow-host/);

    // Non-test host with mismatched --allow-host
    await expect(
      verifyHostOwnership({
        url: 'https://victim.example',
        allowHost: 'other.example',
        active: true,
        allowWrites: false,
        probeKind: 'active-read',
        spendDir,
      }),
    ).rejects.toThrow(/does not match/);
  });

  it('verifies non-test host ownership via /.well-known/miqyas.txt or DNS _miqyas.<host> TXT and requires --allow-writes for mutations', async () => {
    const generated = await resolveOrCreateHostToken('app.example', { spendDir });
    expect(generated.token).toMatch(/^miqyas-verify-/);

    // Rejects when neither well-known nor DNS returns the token
    await expect(
      verifyHostOwnership({
        url: 'https://app.example/dashboard',
        allowHost: 'app.example',
        active: true,
        allowWrites: false,
        probeKind: 'active-read',
        spendDir,
        fetchImpl: async () => new Response('wrong-token', { status: 200 }),
        resolveTxtImpl: async () => [['unrelated=1']],
      }),
    ).rejects.toThrow(/\.well-known\/miqyas\.txt.*_miqyas\.app\.example/);

    // Succeeds via /.well-known/miqyas.txt for active-read
    await expect(
      verifyHostOwnership({
        url: 'https://app.example/dashboard',
        allowHost: 'app.example',
        active: true,
        allowWrites: false,
        probeKind: 'active-read',
        spendDir,
        fetchImpl: async (req) => {
          expect(String(req)).toBe('https://app.example/.well-known/miqyas.txt');
          return new Response(`${generated.token}\n`, { status: 200 });
        },
        resolveTxtImpl: async () => [],
      }),
    ).resolves.toMatchObject({ classification: 'owned-host', verifiedVia: 'well-known' });

    // Succeeds via DNS TXT _miqyas.<host> when well-known returns 404
    await expect(
      verifyHostOwnership({
        url: 'https://app.example/dashboard',
        allowHost: 'app.example',
        active: true,
        allowWrites: false,
        probeKind: 'active-read',
        spendDir,
        fetchImpl: async () => new Response('Not found', { status: 404 }),
        resolveTxtImpl: async (name) => {
          expect(name).toBe('_miqyas.app.example');
          return [[`miqyas-verify=${generated.token}`]];
        },
      }),
    ).resolves.toMatchObject({ classification: 'owned-host', verifiedVia: 'dns-txt' });

    // Refuses active-write without --allow-writes on owned non-test host
    await expect(
      verifyHostOwnership({
        url: 'https://app.example/dashboard',
        allowHost: 'app.example',
        active: true,
        allowWrites: false,
        probeKind: 'active-write',
        spendDir,
        fetchImpl: async () => new Response(generated.token, { status: 200 }),
      }),
    ).rejects.toThrow(/--allow-writes/);

    // Allows active-write with --allow-writes and verified token
    await expect(
      verifyHostOwnership({
        url: 'https://app.example/dashboard',
        allowHost: 'app.example',
        active: true,
        allowWrites: true,
        probeKind: 'active-write',
        spendDir,
        fetchImpl: async () => new Response(generated.token, { status: 200 }),
      }),
    ).resolves.toMatchObject({ classification: 'owned-host', verifiedVia: 'well-known' });
    // Refuses invalid host tokens (e.g. arbitrary HTML strings that could match SPA 200 fallbacks) and HTML well-known responses
    await expect(
      verifyHostOwnership({
        url: 'https://app.example/dashboard',
        allowHost: 'app.example',
        active: true,
        allowWrites: false,
        probeKind: 'active-read',
        expectedToken: '<!doctype',
        spendDir,
        fetchImpl: async () => new Response('<!doctype html>', { status: 200, headers: { 'content-type': 'text/html' } }),
      }),
    ).rejects.toThrow(HostPolicyError);

    await expect(
      verifyHostOwnership({
        url: 'https://app.example/dashboard',
        allowHost: 'app.example',
        active: true,
        allowWrites: false,
        probeKind: 'active-read',
        spendDir,
        fetchImpl: async () =>
          new Response(`<html>${generated.token}</html>`, { status: 200, headers: { 'content-type': 'text/html' } }),
        resolveTxtImpl: async () => [],
      }),
    ).rejects.toThrow(HostPolicyError);
  });

  it('flags form submits, POST/PUT/DELETE forms, and English/Arabic destructive controls while allowing safe view controls', () => {
    expect(isDestructiveControl({ tagName: 'button', type: 'submit', inForm: true, label: 'Search' })).toBe(true);
    expect(isDestructiveControl({ tagName: 'button', inForm: true, label: 'Apply' })).toBe(true);
    expect(isDestructiveControl({ tagName: 'button', type: 'button', formMethod: 'post', label: 'Save' })).toBe(true);
    expect(isDestructiveControl({ tagName: 'button', type: 'button', formMethod: 'delete', label: 'Details' })).toBe(true);
    expect(isDestructiveControl({ tagName: 'button', type: 'button', label: 'Delete Account' })).toBe(true);
    expect(isDestructiveControl({ tagName: 'a', href: '/logout', label: 'Account' })).toBe(true);
    expect(isDestructiveControl({ tagName: 'button', type: 'button', label: 'Pay now' })).toBe(true);
    expect(isDestructiveControl({ tagName: 'button', type: 'button', label: 'Send email' })).toBe(true);

    // Arabic destructive names (with and without hamza variants, including imperatives)
    expect(isDestructiveControl({ tagName: 'button', type: 'button', label: 'حذف الحساب' })).toBe(true);
    expect(isDestructiveControl({ tagName: 'button', type: 'button', label: 'دفع الآن' })).toBe(true);
    expect(isDestructiveControl({ tagName: 'button', type: 'button', label: 'ارسال الرسالة' })).toBe(true);
    expect(isDestructiveControl({ tagName: 'button', type: 'button', label: 'أرسل الآن' })).toBe(true);
    expect(isDestructiveControl({ tagName: 'button', type: 'button', label: 'تسجيل الخروج' })).toBe(true);

    // Safe read-only view controls
    expect(isDestructiveControl({ tagName: 'a', href: '/settings', label: 'Settings' })).toBe(false);
    expect(isDestructiveControl({ tagName: 'button', type: 'button', label: 'الإعدادات' })).toBe(false);
    expect(isDestructiveControl({ tagName: 'button', type: 'button', inForm: true, label: 'More Filters' })).toBe(false);
  });

  it('detects CAPTCHA/WAF blocks and forbids undeclared plan uploads', () => {
    expect(hasCaptchaOrWafSignal({ status: 403, bodyText: 'Attention Required! Cloudflare Turnstile challenge' })).toBeTruthy();
    expect(hasCaptchaOrWafSignal({ status: 200, html: '<div class="g-recaptcha" data-sitekey="x"></div>' })).toBeTruthy();
    expect(hasCaptchaOrWafSignal({ status: 200, bodyText: 'Welcome to dashboard' })).toBeNull();

    expect(() => assertPlanUploadAllowed('./evil.png', ['./avatar.png'])).toThrow(/not declared/);
    expect(() => assertPlanUploadAllowed('./avatar.png', ['./avatar.png'])).not.toThrow();
  });
});
