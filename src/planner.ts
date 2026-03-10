import { Client } from 'pg';

export interface ExplainNode {
  'Node Type': string;
  'Relation Name'?: string;
  'Alias'?: string;
  'Filter'?: string;
  'Join Filter'?: string;
  'Index Cond'?: string;
  'Hash Cond'?: string;
  'Merge Cond'?: string;
  'Plan Rows': number;
  'Actual Rows'?: number;
  'Actual Loops'?: number;
  'Sort Method'?: string;
  'Sort Key'?: string[];
  'Shared Hit Blocks'?: number;
  'Shared Read Blocks'?: number;
  Plans?: ExplainNode[];
  [key: string]: unknown;
}

interface ExplainResult {
  Plan: ExplainNode;
  'Planning Time'?: number;
  'Execution Time'?: number;
}

function hasParameters(query: string): boolean {
  return /\$\d+/.test(query);
}

function isDml(query: string): boolean {
  const trimmed = query.trim().toUpperCase();
  return (
    trimmed.startsWith('INSERT') ||
    trimmed.startsWith('UPDATE') ||
    trimmed.startsWith('DELETE')
  );
}

function replaceParams(query: string): string {
  return query.replace(/\$\d+/g, 'NULL');
}

export async function explainQuery(
  client: Client,
  query: string
): Promise<ExplainNode | null> {
  try {
    const parameterized = hasParameters(query);
    const dml = isDml(query);

    let explainSql: string;
    const targetQuery = parameterized ? replaceParams(query) : query;

    if (parameterized) {
      // Cannot run ANALYZE on parameterized queries safely
      explainSql = `EXPLAIN (FORMAT JSON) ${targetQuery}`;
    } else {
      explainSql = `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${targetQuery}`;
    }

    let result;

    if (dml && !parameterized) {
      // Wrap DML in transaction + rollback to avoid side-effects
      await client.query('BEGIN');
      try {
        result = await client.query(explainSql);
      } finally {
        await client.query('ROLLBACK');
      }
    } else {
      result = await client.query(explainSql);
    }

    const plan = result.rows[0]['QUERY PLAN'] as ExplainResult[];
    return plan[0].Plan;
  } catch {
    // Silently skip queries that can't be explained
    // (e.g., utility commands, SET statements, etc.)
    return null;
  }
}
