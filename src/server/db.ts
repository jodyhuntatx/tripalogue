/**
 * Database: SQLite through Node's built-in node:sqlite (no native add-ons).
 * The schema is small and portable to Postgres when TripAlogue outgrows a
 * single server; all access goes through this module and the services.
 */
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

export type Row = Record<string, unknown>;

const MIGRATIONS: string[] = [
  `
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE login_tokens (
    token_hash TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    next_path TEXT,
    expires_at INTEGER NOT NULL,
    used_at INTEGER
  );
  CREATE TABLE sessions (
    id_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL REFERENCES users(id),
    title TEXT NOT NULL,
    rev INTEGER NOT NULL,
    doc TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE members (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id),
    role TEXT NOT NULL CHECK (role IN ('owner','editor','contributor','viewer')),
    invited_by TEXT,
    joined_at INTEGER NOT NULL,
    PRIMARY KEY (project_id, user_id)
  );
  CREATE TABLE invites (
    token_hash TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    role TEXT NOT NULL,
    invited_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    accepted_by TEXT
  );
  CREATE TABLE operations (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    rev INTEGER NOT NULL,
    author_id TEXT NOT NULL,
    origin TEXT NOT NULL CHECK (origin IN ('client','server')),
    at INTEGER NOT NULL,
    label TEXT NOT NULL,
    ops TEXT NOT NULL,
    PRIMARY KEY (project_id, rev)
  );
  CREATE TABLE versions (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    rev INTEGER NOT NULL,
    author_id TEXT NOT NULL,
    at INTEGER NOT NULL,
    label TEXT NOT NULL,
    auto INTEGER NOT NULL,
    snapshot TEXT NOT NULL
  );
  CREATE INDEX versions_by_project ON versions(project_id, rev);
  CREATE TABLE edit_locks (
    project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE uploads (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    media_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    file_name TEXT NOT NULL,
    size INTEGER NOT NULL,
    received INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    completed_at INTEGER
  );
  CREATE TABLE jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    project_id TEXT NOT NULL,
    media_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('queued','running','done','failed')),
    attempts INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX jobs_queued ON jobs(status, id);
  `,
  // 2: media deleted for good. Edits that would bring one back are refused.
  `
  CREATE TABLE purged_media (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    media_id TEXT NOT NULL,
    purged_at INTEGER NOT NULL,
    PRIMARY KEY (project_id, media_id)
  );
  `,
];

export class Db {
  readonly sql: DatabaseSync;

  constructor(file: string) {
    this.sql = new DatabaseSync(file);
    this.sql.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.migrate();
  }

  static open(dataDir: string): Db {
    return new Db(path.join(dataDir, 'tripalogue.db'));
  }

  private migrate() {
    this.sql.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY)');
    const done = new Set((this.sql.prepare('SELECT version FROM schema_migrations').all() as { version: number }[]).map((r) => r.version));
    MIGRATIONS.forEach((m, i) => {
      if (done.has(i + 1)) return;
      this.tx(() => {
        this.sql.exec(m);
        this.sql.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(i + 1);
      });
    });
  }

  get<T = Row>(query: string, ...params: unknown[]): T | undefined {
    return this.sql.prepare(query).get(...(params as never[])) as T | undefined;
  }
  all<T = Row>(query: string, ...params: unknown[]): T[] {
    return this.sql.prepare(query).all(...(params as never[])) as T[];
  }
  run(query: string, ...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint } {
    return this.sql.prepare(query).run(...(params as never[]));
  }

  /** Run fn in a transaction (synchronous: node:sqlite is synchronous). Nested calls join the outer one. */
  private depth = 0;
  tx<T>(fn: () => T): T {
    if (this.depth > 0) return fn();
    this.depth++;
    this.sql.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.sql.exec('COMMIT');
      return out;
    } catch (e) {
      this.sql.exec('ROLLBACK');
      throw e;
    } finally {
      this.depth--;
    }
  }

  close() {
    this.sql.close();
  }
}
