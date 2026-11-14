// SPDX-License-Identifier: AGPL-3.0-only
// Built-in Check 3 authentication plans (sign-up and log-in templates) and secret environment resolution.

import type { TestAccountSpec } from '../adapters/backend-probe.js';
import type { CrawlResult } from '../surfaces/session.js';
import { tryParseUrl } from '../surfaces/web/policy.js';
import { parsePlan, type Plan } from './plan.js';

export interface Check3AuthTemplateRoutes {
  signupPath: string;
  loginPath: string;
}

export interface Check3AuthTemplateBundle {
  plans: Plan[];
  env: Record<string, string | undefined>;
  routes: Check3AuthTemplateRoutes;
}

const SIGNUP_ROUTE_RE = /\/(?:sign[-_]?up|register|create[-_]?account)(?:\/|$)/i;
const LOGIN_ROUTE_RE = /\/(?:log[-_]?in|sign[-_]?in|auth\/login)(?:\/|$)/i;
const INTERNAL_ROUTE_PATH_RE = /(?:['"`])(\/(?:sign[-_]?up|register|create[-_]?account|log[-_]?in|sign[-_]?in|auth\/login)[A-Za-z0-9/_-]*)(?:['"`])/gi;

function sameOriginPath(rawUrl: string, targetOrigin: string): string | null {
  try {
    const parsed = new URL(rawUrl, targetOrigin);
    if ((parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.origin === targetOrigin) {
      return `${parsed.pathname}${parsed.search}`;
    }
  } catch {
    // ignore malformed path
  }
  return null;
}

export function discoverCheck3AuthRoutes(
  targetUrl: string,
  crawl: CrawlResult | undefined,
  accounts: readonly TestAccountSpec[],
): Check3AuthTemplateRoutes {
  const origin = tryParseUrl(targetUrl)?.origin ?? targetUrl;
  const candidates: string[] = [];
  const addCandidate = (raw: string | undefined) => {
    if (!raw) return;
    const p = sameOriginPath(raw, origin);
    if (p && !candidates.includes(p)) candidates.push(p);
  };

  for (const s of crawl?.screens ?? []) addCandidate(s.url);
  for (const acc of accounts) addCandidate(acc.loginUrl);
  for (const art of crawl?.servedArtifacts ?? []) {
    if (art.kind !== 'bundle' && art.kind !== 'response' && art.kind !== 'dom') continue;
    for (const m of art.text.matchAll(INTERNAL_ROUTE_PATH_RE)) {
      if (m[1]) addCandidate(m[1]);
    }
  }

  const signupPath = candidates.find((p) => SIGNUP_ROUTE_RE.test(p)) ?? '/signup';
  const loginPath = candidates.find((p) => LOGIN_ROUTE_RE.test(p)) ?? '/login';
  return { signupPath, loginPath };
}

function accountIdentifierKey(account: TestAccountSpec): { value: string; fieldLabel: string } | null {
  const email = account.credentials?.email?.trim();
  if (email) {
    return { value: email, fieldLabel: 'email' };
  }
  const username = account.credentials?.username?.trim();
  if (username) {
    return { value: username, fieldLabel: 'username' };
  }
  return null;
}

/** Populate `MIQYAS_SECRET_ACCOUNT_*_PASSWORD` keys for Check 3 template resolution from parsed accounts or base env. */
export function buildCheck3SecretEnv(
  baseEnv: Record<string, string | undefined>,
  accounts: readonly TestAccountSpec[],
): Record<string, string | undefined> {
  const merged: Record<string, string | undefined> = { ...baseEnv };
  for (const acc of accounts) {
    const password = acc.credentials?.password;
    if (password) merged[`MIQYAS_SECRET_ACCOUNT_${acc.name}_PASSWORD`] = password;
  }
  return merged;
}

/**
 * Build the built-in Check 3 sign-up and log-in verification plans when two test accounts have credentials.
 * Returns `null` when two credentialed accounts are missing so Check 3 cleanly reports `not_checked`.
 */
export function buildCheck3AuthTemplates(opts: {
  targetUrl: string;
  crawl?: CrawlResult;
  accounts: readonly TestAccountSpec[];
  env?: Record<string, string | undefined>;
}): Check3AuthTemplateBundle | null {
  if (opts.accounts.length < 2) return null;
  const accountA = opts.accounts.find((a) => a.name === 'A') ?? opts.accounts[0];
  const accountB = opts.accounts.find((a) => a.name === 'B') ?? opts.accounts[1];
  if (!accountA || !accountB || accountA === accountB) return null;

  const idA = accountIdentifierKey(accountA);
  const idB = accountIdentifierKey(accountB);
  const passA = accountA.credentials?.password;
  const passB = accountB.credentials?.password;
  if (!idA || !idB || !passA || !passB) return null;

  const routes = discoverCheck3AuthRoutes(opts.targetUrl, opts.crawl, opts.accounts);
  const env = buildCheck3SecretEnv(opts.env ?? {}, [accountA, accountB]);

  const signupPlan = parsePlan(
    {
      format: 'miqyas-plan',
      version: 1,
      id: 'grade-1/check-3-signup',
      name: 'Grade 1 Check 3: sign-up flow',
      steps: [
        { id: 's1', type: 'action', text: `Navigate to ${routes.signupPath} to open the sign-up form` },
        {
          id: 's2',
          type: 'action',
          text: `Fill ${idB.fieldLabel} with '${idB.value}', fill password with \${secret.ACCOUNT_${accountB.name}_PASSWORD}, and submit the sign-up form`,
        },
        {
          id: 'a1',
          type: 'assertion',
          text: 'Registration succeeds and an authenticated view, welcome confirmation, or account state is visible without signup errors',
        },
      ],
    },
    'grade-1/check-3-signup',
  );

  const loginPlan = parsePlan(
    {
      format: 'miqyas-plan',
      version: 1,
      id: 'grade-1/check-3-login',
      name: 'Grade 1 Check 3: log-in flow',
      steps: [
        { id: 's1', type: 'action', text: `Navigate to ${routes.loginPath} to open the log-in form` },
        {
          id: 's2',
          type: 'action',
          text: `Fill ${idA.fieldLabel} with '${idA.value}', fill password with \${secret.ACCOUNT_${accountA.name}_PASSWORD}, and submit the log-in form`,
        },
        {
          id: 'a1',
          type: 'assertion',
          text: 'Log-in succeeds and an authenticated view or protected content is visible without login errors',
        },
      ],
    },
    'grade-1/check-3-login',
  );

  return {
    plans: [signupPlan, loginPlan],
    env,
    routes,
  };
}
