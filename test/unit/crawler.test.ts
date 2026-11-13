// SPDX-License-Identifier: PolyForm-Shield-1.0.0
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CRAWL_DEPTH,
  DEFAULT_CRAWL_MAX_SCREENS,
  DEFAULT_CRAWL_RPS,
  createRateLimiter,
  filterCrawlTargets,
  normalizeCrawlUrl,
} from '../../src/surfaces/web/crawler.js';

describe('code-driven crawler helpers', () => {
  it('exposes the threat-model default bounds (50 screens, depth 3, 2 req/s)', () => {
    expect(DEFAULT_CRAWL_MAX_SCREENS).toBe(50);
    expect(DEFAULT_CRAWL_DEPTH).toBe(3);
    expect(DEFAULT_CRAWL_RPS).toBe(2);
  });

  it('normalizes same-origin links, keeps hash routes, and rejects off-origin/non-HTTP URLs', () => {
    const base = 'http://127.0.0.1:4173';
    expect(normalizeCrawlUrl('/settings', `${base}/`, base)).toBe(`${base}/settings`);
    expect(normalizeCrawlUrl('/docs#top', `${base}/`, base)).toBe(`${base}/docs`);
    expect(normalizeCrawlUrl('#/billing', `${base}/`, base)).toBe(`${base}/#/billing`);
    expect(normalizeCrawlUrl('https://evil.example/steal', `${base}/`, base)).toBeNull();
    expect(normalizeCrawlUrl('mailto:test@example.com', `${base}/`, base)).toBeNull();
    expect(normalizeCrawlUrl('javascript:void(0)', `${base}/`, base)).toBeNull();
  });

  it('enforces max requests per second pacing', async () => {
    let clock = 1000;
    const sleeps: number[] = [];
    const limiter = createRateLimiter(
      2,
      () => clock,
      async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
    );
    await limiter.acquire();
    clock += 100;
    await limiter.acquire();
    expect(sleeps).toEqual([400]);
    clock += 600;
    await limiter.acquire();
    expect(sleeps).toEqual([400]);
  });

  it('filters out off-origin links, form submits, POST/PUT/DELETE forms, and EN/AR destructive controls', () => {
    const base = 'http://127.0.0.1:4173';
    const filtered = filterCrawlTargets(
      {
        links: [
          { href: '/about', label: 'About', tagName: 'a' },
          { href: 'https://other.example/x', label: 'External', tagName: 'a' },
          { href: '/logout', label: 'Log out', tagName: 'a' },
          { href: '/clean-account', label: 'حذف الحساب', tagName: 'a' },
        ],
        controls: [
          { selectorIndex: 0, tagName: 'button', type: 'button', label: 'Show Details' },
          { selectorIndex: 1, tagName: 'button', type: 'submit', inForm: true, label: 'Search' },
          { selectorIndex: 2, tagName: 'button', type: 'button', formMethod: 'post', label: 'Save' },
          { selectorIndex: 3, tagName: 'button', type: 'button', label: 'Pay now' },
          { selectorIndex: 4, tagName: 'button', type: 'button', label: 'إرسال الطلب' },
        ],
      },
      `${base}/`,
      base,
    );
    expect(filtered.links).toEqual([`${base}/about`]);
    expect(filtered.skippedOffOriginLinks).toBe(1);
    expect(filtered.controlIndices).toEqual([0]);
    expect(filtered.skippedControls).toBe(6);
  });
});
