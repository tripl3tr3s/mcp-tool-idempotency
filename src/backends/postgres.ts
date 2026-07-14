import type { ClaimMeta, IdempotencyBackend, StoredRecord } from '../store.js';

/**
 * Minimal parameterized-query surface. Adapt over `pg`
 * (`(text, params) => client.query(text, params).then(r => r.rows)`),
 * `postgres`, or any driver. Parameters are always bound, never interpolated.
 */
export interface SqlExecutor {
  query<Row = Record<string, unknown>>(text: string, params: unknown[]): Promise<Row[]>;
}

interface DbRow {
  key: string;
  status: StoredRecord['status'];
  response: string | null;
  created_at: string | number;
  expires_at: string | number;
}

const TABLE = 'idempotency_keys';

/**
 * PostgreSQL-backed idempotency store. The atomic claim uses
 * `INSERT ... ON CONFLICT (key) DO NOTHING RETURNING key`, so the check and the
 * write are a single operation - no read-then-write race. See
 * `migrations/001_idempotency_keys.sql` for the schema.
 */
export class PostgresBackend implements IdempotencyBackend {
  constructor(private readonly sql: SqlExecutor) {}

  async check(key: string): Promise<StoredRecord | undefined> {
    const rows = await this.sql.query<DbRow>(
      `SELECT key, status, response, created_at, expires_at FROM ${TABLE} WHERE key = $1 AND expires_at > $2`,
      [key, Date.now()]
    );
    const row = rows[0];
    if (!row) return undefined;
    return {
      key: row.key,
      status: row.status,
      response: row.response ?? undefined,
      createdAt: Number(row.created_at),
      expiresAt: Number(row.expires_at),
    };
  }

  async claim(key: string, meta: ClaimMeta): Promise<boolean> {
    const rows = await this.sql.query(
      `INSERT INTO ${TABLE} (key, tool_name, request, status, created_at, expires_at)
       VALUES ($1, $2, $3, 'pending', $4, $5)
       ON CONFLICT (key) DO NOTHING
       RETURNING key`,
      [key, meta.toolName, meta.request, Date.now(), meta.expiresAt]
    );
    return rows.length > 0;
  }

  async complete(key: string, response: string): Promise<void> {
    await this.sql.query(
      `UPDATE ${TABLE} SET status = 'completed', response = $2 WHERE key = $1`,
      [key, response]
    );
  }

  async fail(key: string): Promise<void> {
    await this.sql.query(
      `UPDATE ${TABLE} SET status = 'failed', response = NULL WHERE key = $1`,
      [key]
    );
  }

  async reset(key: string, meta: ClaimMeta): Promise<void> {
    await this.sql.query(
      `UPDATE ${TABLE} SET tool_name = $2, request = $3, status = 'pending', response = NULL, created_at = $4, expires_at = $5 WHERE key = $1`,
      [key, meta.toolName, meta.request, Date.now(), meta.expiresAt]
    );
  }

  async cleanupExpired(): Promise<void> {
    await this.sql.query(`DELETE FROM ${TABLE} WHERE expires_at < $1`, [Date.now()]);
  }
}
