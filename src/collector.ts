import { Client } from 'pg';

export interface SlowQuery {
  queryId: string;
  query: string;
  calls: number;
  meanTime: number;
  totalTime: number;
}

export class PgStatStatementsNotActiveError extends Error {
  constructor() {
    super(
      'pg_stat_statements extension is not available.\n\n' +
      'To enable it:\n' +
      '  1. Add to postgresql.conf:\n' +
      '     shared_preload_libraries = \'pg_stat_statements\'\n' +
      '  2. Restart PostgreSQL\n' +
      '  3. Run in your database:\n' +
      '     CREATE EXTENSION IF NOT EXISTS pg_stat_statements;\n'
    );
    this.name = 'PgStatStatementsNotActiveError';
  }
}

export async function collectSlowQueries(client: Client): Promise<SlowQuery[]> {
  // Check if pg_stat_statements is available
  const extCheck = await client.query(
    `SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements'`
  );

  if (extCheck.rowCount === 0) {
    throw new PgStatStatementsNotActiveError();
  }

  const result = await client.query(`
    SELECT
      queryid::text    AS query_id,
      query,
      calls,
      mean_exec_time   AS mean_time,
      total_exec_time  AS total_time
    FROM pg_stat_statements
    WHERE query NOT LIKE '%pg_stat_statements%'
      AND queryid IS NOT NULL
    ORDER BY mean_exec_time DESC
    LIMIT 20
  `);

  return result.rows.map((row) => ({
    queryId: row.query_id,
    query: row.query,
    calls: Number(row.calls),
    meanTime: Number(row.mean_time),
    totalTime: Number(row.total_time),
  }));
}
