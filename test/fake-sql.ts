import type { SqlExecutor } from '../src/index.js';

export interface FakeRow {
  key: string;
  tool_name: string;
  request: string;
  status: 'pending' | 'completed' | 'failed' | 'uncertain';
  response: string | null;
  owner: string | null;
  lease_expires_at: number | null;
  created_at: number;
  expires_at: number;
}

/**
 * In-memory stand-in for a Postgres driver. It recognizes each statement
 * PostgresBackend issues by its SET/verb clause and applies the same WHERE
 * conditions in JS, including `ON CONFLICT (key) DO NOTHING` (conflicts on the
 * primary key regardless of expiry) and `RETURNING key` (affected rows only).
 */
export class FakeSql implements SqlExecutor {
  readonly rows = new Map<string, FakeRow>();
  readonly statements: string[] = [];

  query<Row = Record<string, unknown>>(text: string, params: unknown[]): Promise<Row[]> {
    const t = text.replace(/\s+/g, ' ').trim();
    this.statements.push(t);
    return Promise.resolve(this.run(t, params) as unknown as Row[]);
  }

  private run(t: string, p: unknown[]): unknown[] {
    const key = p[0] as string;
    const row = this.rows.get(key);

    if (t.startsWith('SELECT')) {
      return row && row.expires_at > (p[1] as number) ? [row] : [];
    }

    if (t.startsWith('INSERT')) {
      if (row) return [];
      const [, toolName, request, owner, lease, createdAt, expiresAt] = p as [
        string,
        string,
        string,
        string,
        number,
        number,
        number,
      ];
      this.rows.set(key, {
        key,
        tool_name: toolName,
        request,
        status: 'pending',
        response: null,
        owner,
        lease_expires_at: lease,
        created_at: createdAt,
        expires_at: expiresAt,
      });
      return [{ key }];
    }

    if (t.startsWith('UPDATE') && t.includes('SET tool_name')) {
      const [, toolName, request, owner, lease, now, expiresAt] = p as [
        string,
        string,
        string,
        string,
        number,
        number,
        number,
      ];
      const replaceable =
        row !== undefined &&
        (row.expires_at <= now ||
          row.status === 'failed' ||
          (row.status === 'pending' &&
            (row.lease_expires_at === null || row.lease_expires_at <= now)));
      if (!replaceable) return [];
      this.rows.set(key, {
        key,
        tool_name: toolName,
        request,
        status: 'pending',
        response: null,
        owner,
        lease_expires_at: lease,
        created_at: now,
        expires_at: expiresAt,
      });
      return [{ key }];
    }

    if (t.startsWith('UPDATE')) {
      const owner = p[1] as string;
      if (!row || row.owner !== owner || row.status !== 'pending') return [];
      if (t.includes('SET lease_expires_at')) {
        this.rows.set(key, { ...row, lease_expires_at: p[2] as number });
      } else if (t.includes("SET status = 'completed'")) {
        this.rows.set(key, { ...row, status: 'completed', response: p[2] as string });
      } else if (t.includes("SET status = 'failed'")) {
        this.rows.set(key, { ...row, status: 'failed', response: null });
      } else if (t.includes("SET status = 'uncertain'")) {
        this.rows.set(key, {
          ...row,
          status: 'uncertain',
          response: null,
          expires_at: p[2] as number,
        });
      } else {
        throw new Error(`FakeSql: unhandled UPDATE: ${t}`);
      }
      return [{ key }];
    }

    if (t.startsWith('DELETE') && t.includes('WHERE key')) {
      this.rows.delete(key);
      return [];
    }

    if (t.startsWith('DELETE')) {
      const now = p[0] as number;
      for (const [k, r] of this.rows) {
        if (r.expires_at < now) this.rows.delete(k);
      }
      return [];
    }

    throw new Error(`FakeSql: unhandled query: ${t}`);
  }
}
