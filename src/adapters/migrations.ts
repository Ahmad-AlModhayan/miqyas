// SPDX-License-Identifier: PolyForm-Shield-1.0.0
// SQL migration RLS analyzer (ADR 0005, FR-Q4, Check 7): parses repository SQL migrations via libpg-query (MIT)
// and verifies that every remaining permanent table in the `public` schema has Row Level Security enabled.

import { existsSync, readFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse as parsePgSql } from 'libpg-query';
import type { Adapter, AdapterContext, AdapterFinding, AdapterResult } from './adapter.js';

export interface PublicTableRlsState {
  schema: string;
  table: string;
  createdInFile: string;
  rlsEnabled: boolean;
  rlsEnabledInFile?: string;
  hasPolicy: boolean;
}

export interface MigrationRlsAnalysis {
  status: 'ok' | 'no_migrations' | 'error';
  version: string;
  files: string[];
  publicTables: PublicTableRlsState[];
  missingRlsTables: PublicTableRlsState[];
  coverage: string;
  error?: string;
}

const MIGRATION_DIR_CANDIDATES = [
  'supabase/migrations',
  'migrations',
  'prisma/migrations',
  'db/migrations',
  'db/migrate',
  'drizzle',
  'sql/migrations',
] as const;

const SKIP_WALK_DIRS = new Set(['.git', 'node_modules', 'dist', '.next', '.nuxt', 'coverage']);

function readLibpgQueryVersion(): string {
  try {
    const pkgUrl = new URL('../../node_modules/libpg-query/package.json', import.meta.url);
    const parsed = JSON.parse(readFileSync(pkgUrl, 'utf8')) as { version?: unknown };
    if (typeof parsed.version === 'string' && parsed.version.trim()) return parsed.version.trim();
  } catch {
    // fallback if bundled outside node_modules layout
  }
  return '18.2.4';
}

export const LIBPG_QUERY_VERSION = readLibpgQueryVersion();

/** Discover SQL migration files under standard repository migration roots, returned sorted deterministically. */
export async function findMigrationSqlFiles(repoDir: string, maxFiles = 2000): Promise<string[]> {
  const seen = new Set<string>();
  const files: string[] = [];

  const walk = async (dir: string): Promise<void> => {
    if (files.length >= maxFiles) return;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const ent of entries) {
      if (files.length >= maxFiles) break;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (!SKIP_WALK_DIRS.has(ent.name)) await walk(full);
        continue;
      }
      if (!ent.isFile() || !ent.name.toLowerCase().endsWith('.sql')) continue;
      const rel = path.relative(repoDir, full).split(path.sep).join('/');
      if (!seen.has(rel)) {
        seen.add(rel);
        files.push(rel);
      }
    }
  };

  for (const cand of MIGRATION_DIR_CANDIDATES) {
    const abs = path.join(repoDir, cand);
    if (existsSync(abs)) await walk(abs);
  }
  files.sort((a, b) => a.localeCompare(b));
  return files;
}

interface PgRangeVar {
  schemaname?: string;
  relname?: string;
  relpersistence?: string;
}

interface PgAstStmt {
  CreateStmt?: {
    relation?: PgRangeVar;
    if_not_exists?: boolean;
  };
  CreateTableAsStmt?: {
    into?: { rel?: PgRangeVar };
    if_not_exists?: boolean;
  };
  AlterTableStmt?: {
    relation?: PgRangeVar;
    objtype?: string;
    cmds?: { AlterTableCmd?: { subtype?: string } }[];
  };
  AlterObjectSchemaStmt?: {
    objectType?: string;
    relation?: PgRangeVar;
    newschema?: string;
  };
  RenameStmt?: {
    renameType?: string;
    relation?: PgRangeVar;
    newname?: string;
  };
  CreatePolicyStmt?: {
    table?: PgRangeVar;
  };
  DropStmt?: {
    removeType?: string;
    objects?: { List?: { items?: { String?: { sval?: string } }[] } }[];
  };
}

function resolveRangeVar(rel: PgRangeVar | undefined): { schema: string; table: string } | null {
  if (!rel?.relname) return null;
  return { schema: rel.schemaname || 'public', table: rel.relname };
}

function applyStmtToState(
  rawStmt: PgAstStmt,
  relFile: string,
  tables: Map<string, PublicTableRlsState>,
): void {
  if (rawStmt.CreateStmt?.relation) {
    const rel = rawStmt.CreateStmt.relation;
    if (rel.relpersistence === 't') return; // temporary tables are session-scoped, never exposed
    const ref = resolveRangeVar(rel);
    if (!ref) return;
    const key = `${ref.schema}.${ref.table}`;
    if (!rawStmt.CreateStmt.if_not_exists || !tables.has(key)) {
      tables.set(key, { schema: ref.schema, table: ref.table, createdInFile: relFile, rlsEnabled: false, hasPolicy: false });
    }
    return;
  }

  if (rawStmt.CreateTableAsStmt?.into?.rel) {
    const rel = rawStmt.CreateTableAsStmt.into.rel;
    if (rel.relpersistence === 't') return;
    const ref = resolveRangeVar(rel);
    if (!ref) return;
    const key = `${ref.schema}.${ref.table}`;
    if (!rawStmt.CreateTableAsStmt.if_not_exists || !tables.has(key)) {
      tables.set(key, { schema: ref.schema, table: ref.table, createdInFile: relFile, rlsEnabled: false, hasPolicy: false });
    }
    return;
  }

  if (rawStmt.AlterTableStmt?.relation) {
    const ref = resolveRangeVar(rawStmt.AlterTableStmt.relation);
    if (!ref) return;
    const key = `${ref.schema}.${ref.table}`;
    for (const cmdWrapper of rawStmt.AlterTableStmt.cmds ?? []) {
      const cmd = cmdWrapper.AlterTableCmd;
      if (!cmd?.subtype) continue;
      if (cmd.subtype === 'AT_EnableRowSecurity') {
        const cur = tables.get(key) ?? { schema: ref.schema, table: ref.table, createdInFile: relFile, rlsEnabled: false, hasPolicy: false };
        cur.rlsEnabled = true;
        cur.rlsEnabledInFile = relFile;
        tables.set(key, cur);
      } else if (cmd.subtype === 'AT_DisableRowSecurity') {
        const cur = tables.get(key);
        if (cur) {
          cur.rlsEnabled = false;
          delete cur.rlsEnabledInFile;
        }
      }
    }
    return;
  }

  if (rawStmt.AlterObjectSchemaStmt?.objectType === 'OBJECT_TABLE' && rawStmt.AlterObjectSchemaStmt.relation && rawStmt.AlterObjectSchemaStmt.newschema) {
    const ref = resolveRangeVar(rawStmt.AlterObjectSchemaStmt.relation);
    const nextSchema = rawStmt.AlterObjectSchemaStmt.newschema;
    if (!ref) return;
    const oldKey = `${ref.schema}.${ref.table}`;
    const existing = tables.get(oldKey);
    tables.delete(oldKey);
    const nextKey = `${nextSchema}.${ref.table}`;
    tables.set(nextKey, existing
      ? { ...existing, schema: nextSchema }
      : { schema: nextSchema, table: ref.table, createdInFile: relFile, rlsEnabled: false, hasPolicy: false });
    return;
  }

  if (rawStmt.RenameStmt?.renameType === 'OBJECT_TABLE' && rawStmt.RenameStmt.relation && rawStmt.RenameStmt.newname) {
    const ref = resolveRangeVar(rawStmt.RenameStmt.relation);
    const nextName = rawStmt.RenameStmt.newname;
    if (!ref) return;
    const oldKey = `${ref.schema}.${ref.table}`;
    const existing = tables.get(oldKey);
    tables.delete(oldKey);
    const nextKey = `${ref.schema}.${nextName}`;
    tables.set(nextKey, existing
      ? { ...existing, table: nextName }
      : { schema: ref.schema, table: nextName, createdInFile: relFile, rlsEnabled: false, hasPolicy: false });
    return;
  }

  if (rawStmt.CreatePolicyStmt?.table) {
    const ref = resolveRangeVar(rawStmt.CreatePolicyStmt.table);
    if (!ref) return;
    const cur = tables.get(`${ref.schema}.${ref.table}`);
    if (cur) cur.hasPolicy = true;
    return;
  }

  if (rawStmt.DropStmt?.removeType === 'OBJECT_TABLE') {
    for (const obj of rawStmt.DropStmt.objects ?? []) {
      const parts = (obj.List?.items ?? []).map((x) => x.String?.sval).filter((s): s is string => Boolean(s));
      if (parts.length === 1) {
        tables.delete(`public.${parts[0]}`);
      } else if (parts.length >= 2) {
        const schema = parts[parts.length - 2]!;
        const table = parts[parts.length - 1]!;
        tables.delete(`${schema}.${table}`);
      }
    }
  }
}

/** Parse SQL migrations under `repoDir` via libpg-query and check RLS coverage across all remaining public tables. */
export async function analyzeMigrationsRls(repoDir: string): Promise<MigrationRlsAnalysis> {
  const files = await findMigrationSqlFiles(repoDir);
  if (files.length === 0) {
    return {
      status: 'no_migrations',
      version: LIBPG_QUERY_VERSION,
      files: [],
      publicTables: [],
      missingRlsTables: [],
      coverage: '0 SQL migration files found',
    };
  }

  const tables = new Map<string, PublicTableRlsState>();
  for (const relFile of files) {
    const full = path.join(repoDir, relFile);
    const sql = await readFile(full, 'utf8');
    if (!sql.trim()) continue;
    let ast: { stmts?: { stmt?: PgAstStmt }[] };
    try {
      ast = (await parsePgSql(sql)) as { stmts?: { stmt?: PgAstStmt }[] };
    } catch (e) {
      const msg = (e as Error).message.split('\n')[0] || 'SQL parse failed';
      return {
        status: 'error',
        version: LIBPG_QUERY_VERSION,
        files,
        publicTables: [...tables.values()],
        missingRlsTables: [],
        coverage: `${files.length} migration file(s) discovered; parse failed in ${relFile}`,
        error: `${relFile}: ${msg}`,
      };
    }
    for (const wrapper of ast.stmts ?? []) {
      if (wrapper.stmt) applyStmtToState(wrapper.stmt, relFile, tables);
    }
  }

  const publicTables = [...tables.values()].filter((t) => t.schema === 'public');
  const missingRlsTables = publicTables.filter((t) => !t.rlsEnabled);
  return {
    status: 'ok',
    version: LIBPG_QUERY_VERSION,
    files,
    publicTables,
    missingRlsTables,
    coverage: `${files.length} migration file(s), ${publicTables.length} public table(s) parsed`,
  };
}

/** Adapter wrapper for Check 7 (SQL migration RLS parsing via libpg-query). */
export class MigrationsRlsAdapter implements Adapter {
  readonly id = 'libpg-query';
  readonly version = LIBPG_QUERY_VERSION;
  readonly kind = 'scanner' as const;
  readonly surfaces = ['web'] as const;

  async run(ctx: AdapterContext): Promise<AdapterResult> {
    if (!ctx.buildDir) {
      return { adapterId: this.id, version: this.version, status: 'skipped', findings: [], detail: 'no repository path provided' };
    }
    const analysis = await analyzeMigrationsRls(ctx.buildDir);
    if (analysis.status === 'no_migrations') {
      return { adapterId: this.id, version: this.version, coverage: analysis.coverage, status: 'skipped', findings: [], detail: analysis.coverage };
    }
    if (analysis.status === 'error') {
      return { adapterId: this.id, version: this.version, coverage: analysis.coverage, status: 'error', findings: [], ...(analysis.error ? { error: analysis.error } : {}) };
    }
    const findings: AdapterFinding[] = analysis.missingRlsTables.map((t, i) => ({
      id: `missing-rls:${i + 1}`,
      title: `Public table ${t.schema}.${t.table} has RLS disabled`,
      severity: 'high',
      summary: `${t.createdInFile}: ${t.schema}.${t.table} lacks ALTER TABLE ... ENABLE ROW LEVEL SECURITY`,
      source: 'libpg-query',
    }));
    return { adapterId: this.id, version: this.version, coverage: analysis.coverage, status: 'ok', findings };
  }
}
