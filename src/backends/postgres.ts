import type { ClaimMeta, IdempotencyBackend, StoredRecord } from '../store.js';

/**
 * Minimal parameterized-query surface. Adapt over `pg`
 * (`(text, params) => client.query(text, params).then(r => r.rows)`),
 * `postgres`, or any driver. Parameters are always bound, never interpolated.
 * Must return the rows of `RETURNING` clauses.
 */
export interface SqlExecutor {
  query<Row = Record<string, unknown>>(text: string, params: unknown[]): Promise<Row[]>;
}

interface DbRow {
  key: string;
  status: StoredRecord['status'];
  request: string | null;
  response: string | null;
  owner: string | null;
  lease_expires_at: string | number | null;
  created_at: string | number;
  expires_at: string | number;
}

const TABLE = 'idempotency_keys';

/**
 * PostgreSQL-backed idempotency store. See `migrations/` for the schema (run
 * 001 then 002).
 *
 * - `claim` is `INSERT ... ON CONFLICT (key) DO NOTHING RETURNING key`: check
 *   and write are one statement, so only one caller wins.
 * - `takeOver` is a single conditional `UPDATE ... WHERE <row is replaceable>
 *   RETURNING key`. Postgres re-evaluates the WHERE clause after taking the row
 *   lock, so concurrent contenders cannot both win.
 * - `renew` / `complete` / `fail` / `markUncertain` are gated on
 *   `owner = $2 AND status = 'pending'`, so a holder that lost its lease cannot
 *   overwrite the new holder's row.
 */
export class PostgresBackend implements IdempotencyBackend {
  constructor(private readonly sql: SqlExecutor) {}

  async check(key: string): Promise<StoredRecord | undefined> {
    const rows = await this.sql.query<DbRow>(
      `SELECT key, status, request, response, owner, lease_expires_at, created_at, expires_at
       FROM ${TABLE} WHERE key = $1 AND expires_at > $2`,
      [key, Date.now()]
    );
    const row = rows[0];
    if (!row) return undefined;
    return {
      key: row.key,
      status: row.status,
      request: row.request ?? undefined,
      response: row.response ?? undefined,
      owner: row.owner ?? undefined,
      leaseExpiresAt: row.lease_expires_at === null ? undefined : Number(row.lease_expires_at),
      createdAt: Number(row.created_at),
      expiresAt: Number(row.expires_at),
    };
  }

  async claim(key: string, meta: ClaimMeta): Promise<boolean> {
    const rows = await this.sql.query(
      `INSERT INTO ${TABLE} (key, tool_name, request, owner, lease_expires_at, status, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7)
       ON CONFLICT (key) DO NOTHING
       RETURNING key`,
      [
        key,
        meta.toolName,
        meta.request,
        meta.owner,
        meta.leaseExpiresAt,
        Date.now(),
        meta.expiresAt,
      ]
    );
    return rows.length > 0;
  }

  async takeOver(key: string, meta: ClaimMeta, now: number): Promise<boolean> {
    const rows = await this.sql.query(
      `UPDATE ${TABLE}
       SET tool_name = $2, request = $3, owner = $4, lease_expires_at = $5,
           status = 'pending', response = NULL, created_at = $6, expires_at = $7
       WHERE key = $1
         AND (expires_at <= $6
              OR status = 'failed'
              OR (status = 'pending' AND (lease_expires_at IS NULL OR lease_expires_at <= $6)))
       RETURNING key`,
      [key, meta.toolName, meta.request, meta.owner, meta.leaseExpiresAt, now, meta.expiresAt]
    );
    return rows.length > 0;
  }

  async renew(key: string, owner: string, leaseExpiresAt: number): Promise<boolean> {
    const rows = await this.sql.query(
      `UPDATE ${TABLE} SET lease_expires_at = $3
       WHERE key = $1 AND owner = $2 AND status = 'pending'
       RETURNING key`,
      [key, owner, leaseExpiresAt]
    );
    return rows.length > 0;
  }

  async complete(key: string, owner: string, response: string): Promise<boolean> {
    const rows = await this.sql.query(
      `UPDATE ${TABLE} SET status = 'completed', response = $3
       WHERE key = $1 AND owner = $2 AND status = 'pending'
       RETURNING key`,
      [key, owner, response]
    );
    return rows.length > 0;
  }

  async fail(key: string, owner: string): Promise<void> {
    await this.sql.query(
      `UPDATE ${TABLE} SET status = 'failed', response = NULL
       WHERE key = $1 AND owner = $2 AND status = 'pending'`,
      [key, owner]
    );
  }

  async markUncertain(key: string, owner: string, expiresAt: number): Promise<boolean> {
    const rows = await this.sql.query(
      `UPDATE ${TABLE} SET status = 'uncertain', response = NULL, expires_at = $3
       WHERE key = $1 AND owner = $2 AND status = 'pending'
       RETURNING key`,
      [key, owner, expiresAt]
    );
    return rows.length > 0;
  }

  async forget(key: string): Promise<void> {
    await this.sql.query(`DELETE FROM ${TABLE} WHERE key = $1`, [key]);
  }

  async cleanupExpired(): Promise<void> {
    await this.sql.query(`DELETE FROM ${TABLE} WHERE expires_at < $1`, [Date.now()]);
  }
}
