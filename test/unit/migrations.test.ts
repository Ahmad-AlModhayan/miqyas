// SPDX-License-Identifier: AGPL-3.0-only
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { analyzeMigrationsRls, LIBPG_QUERY_VERSION, MigrationsRlsAdapter } from '../../src/adapters/migrations.js';

const temps: string[] = [];
function makeRepo(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'miqyas-migrations-unit-'));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true });
});

describe('libpg-query SQL migration RLS analyzer (Check 7, #17)', () => {
  it('passes when all remaining public tables enable RLS across sequential migrations and ignores private/temp/dropped tables', async () => {
    const repo = makeRepo();
    const migDir = path.join(repo, 'supabase', 'migrations');
    mkdirSync(migDir, { recursive: true });
    writeFileSync(
      path.join(migDir, '001_tables.sql'),
      `
      create table orders (id uuid primary key);
      create table public."OrderItems" (id bigint primary key);
      create table public.deprecated_tbl (id int);
      create table private.internal_audit (id int);
      create temp table tmp_scratch (x int);
      `,
    );
    writeFileSync(
      path.join(migDir, '002_rls.sql'),
      `
      alter table public.orders enable row level security;
      alter table if exists public."OrderItems" enable row level security;
      create policy "orders_owner" on public.orders for select using (true);
      drop table public.deprecated_tbl;
      `,
    );

    const res = await analyzeMigrationsRls(repo);
    expect(res.status).toBe('ok');
    expect(res.version).toBe(LIBPG_QUERY_VERSION);
    expect(res.files).toEqual(['supabase/migrations/001_tables.sql', 'supabase/migrations/002_rls.sql']);
    expect(res.publicTables.map((t) => t.table)).toEqual(['orders', 'OrderItems']);
    expect(res.missingRlsTables).toEqual([]);
  });

  it('flags public tables missing RLS or whose RLS was disabled in a subsequent migration', async () => {
    const repo = makeRepo();
    const migDir = path.join(repo, 'migrations');
    mkdirSync(migDir, { recursive: true });
    writeFileSync(
      path.join(migDir, '001_init.sql'),
      `
      create table public.invoices (id int);
      alter table public.invoices enable row level security;
      create table public.profiles (id uuid);
      `,
    );
    writeFileSync(
      path.join(migDir, '002_regression.sql'),
      `
      alter table public.invoices disable row level security;
      `,
    );

    const res = await analyzeMigrationsRls(repo);
    expect(res.status).toBe('ok');
    expect(res.publicTables).toHaveLength(2);
    expect(res.missingRlsTables.map((t) => t.table)).toEqual(['invoices', 'profiles']);

    const adapterOut = await new MigrationsRlsAdapter().run({
      surface: 'web',
      url: 'http://127.0.0.1:3000/',
      runDir: repo,
      buildDir: repo,
    });
    expect(adapterOut.status).toBe('ok');
    expect(adapterOut.findings).toHaveLength(2);
  });

  it('reports no_migrations when repository has no SQL migrations and error on invalid SQL syntax', async () => {
    const emptyRepo = makeRepo();
    expect((await analyzeMigrationsRls(emptyRepo)).status).toBe('no_migrations');

    const badRepo = makeRepo();
    mkdirSync(path.join(badRepo, 'supabase', 'migrations'), { recursive: true });
    writeFileSync(path.join(badRepo, 'supabase', 'migrations', '001_bad.sql'), 'create table public.broken (((;');
    const badRes = await analyzeMigrationsRls(badRepo);
    expect(badRes.status).toBe('error');
    expect(badRes.error).toContain('001_bad.sql');
  });

  it('tracks AlterObjectSchemaStmt (SET SCHEMA) and RenameStmt (RENAME TO) accurately across public and private schemas', async () => {
    const repo = makeRepo();
    const migDir = path.join(repo, 'supabase', 'migrations');
    mkdirSync(migDir, { recursive: true });
    writeFileSync(
      path.join(migDir, '001_schema_moves.sql'),
      `
      create table public.moved_out (id int);
      create table private.promoted_protected (id int);
      alter table private.promoted_protected enable row level security;
      create table private.promoted_unprotected (id int);
      create table public.old_orders (id int);
      alter table public.old_orders enable row level security;
      create table public.old_unprotected (id int);
      `,
    );
    writeFileSync(
      path.join(migDir, '002_moves_renames.sql'),
      `
      alter table public.moved_out set schema private;
      alter table private.promoted_protected set schema public;
      alter table private.promoted_unprotected set schema public;
      alter table public.old_orders rename to customer_orders;
      alter table public.old_unprotected rename to exposed_items;
      `,
    );

    const res = await analyzeMigrationsRls(repo);
    expect(res.status).toBe('ok');
    expect(res.publicTables.map((t) => t.table).sort()).toEqual([
      'customer_orders',
      'exposed_items',
      'promoted_protected',
      'promoted_unprotected',
    ]);
    expect(res.missingRlsTables.map((t) => t.table).sort()).toEqual([
      'exposed_items',
      'promoted_unprotected',
    ]);
  });
});
