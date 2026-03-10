import { ExplainNode } from './planner';
import { SlowQuery } from './collector';

export interface Diagnostic {
  rule: string;
  table: string;
  query: string;
  detail: string;
  suggestion: string;
  severity: 'warning' | 'critical';
}

// ---------------------------------------------------------------------------
// Tree walker
// ---------------------------------------------------------------------------

function walkNodes(node: ExplainNode, callback: (n: ExplainNode) => void): void {
  callback(node);
  if (node.Plans) {
    for (const child of node.Plans) {
      walkNodes(child, callback);
    }
  }
}

// ---------------------------------------------------------------------------
// Helper: extract column name from a Filter expression
// ---------------------------------------------------------------------------

function extractFilterColumn(filter: string): string {
  // Typical filter: "((status)::text = 'active'::text)" or "(age > 30)"
  const match = filter.match(/\((\w+)\)/);
  return match ? match[1] : filter.replace(/[()]/g, '').split(/\s/)[0];
}

// ---------------------------------------------------------------------------
// Helper: extract join column from a condition
// ---------------------------------------------------------------------------

function extractJoinColumn(node: ExplainNode): string {
  const cond =
    node['Join Filter'] ||
    node['Hash Cond'] ||
    node['Merge Cond'] ||
    node['Index Cond'];
  if (!cond) return '<join column>';
  // e.g. "(a.id = b.user_id)" → try to extract the right-hand side
  const match = String(cond).match(/(\w+)\.(\w+)\s*=\s*(\w+)\.(\w+)/);
  if (match) return `${match[3]}.${match[4]}`;
  return String(cond).replace(/[()]/g, '').trim();
}

// ---------------------------------------------------------------------------
// Helper: find the inner relation table of a Nested Loop
// ---------------------------------------------------------------------------

function findInnerRelation(node: ExplainNode): string {
  if (node.Plans && node.Plans.length >= 2) {
    const inner = node.Plans[1];
    return inner['Relation Name'] || inner['Alias'] || '<inner table>';
  }
  return '<inner table>';
}

// ---------------------------------------------------------------------------
// Rule 1: SEQ_SCAN_LARGE
// ---------------------------------------------------------------------------

export function checkSeqScanLarge(
  plan: ExplainNode,
  query: string
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  walkNodes(plan, (node) => {
    if (
      node['Node Type'] === 'Seq Scan' &&
      node['Plan Rows'] > 100_000 &&
      node['Filter']
    ) {
      const table = node['Relation Name'] || node['Alias'] || '<unknown>';
      const col = extractFilterColumn(node['Filter']);
      diagnostics.push({
        rule: 'SEQ_SCAN_LARGE',
        table,
        query,
        detail: `Sequential scan on "${table}" with ~${node['Plan Rows'].toLocaleString()} estimated rows and a filter on "${col}". An index could eliminate the full table scan.`,
        suggestion: `CREATE INDEX idx_${table}_${col} ON ${table} (${col});`,
        severity: 'warning',
      });
    }
  });

  return diagnostics;
}

// ---------------------------------------------------------------------------
// Rule 2: BAD_CARDINALITY
// ---------------------------------------------------------------------------

export function checkBadCardinality(
  plan: ExplainNode,
  query: string
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  walkNodes(plan, (node) => {
    const actualRows = node['Actual Rows'];
    const planRows = node['Plan Rows'];
    if (
      actualRows !== undefined &&
      planRows > 0 &&
      actualRows > 10 * planRows
    ) {
      const table = node['Relation Name'] || node['Alias'] || '<unknown>';
      diagnostics.push({
        rule: 'BAD_CARDINALITY',
        table,
        query,
        detail: `Planner estimated ${planRows.toLocaleString()} rows but got ${actualRows.toLocaleString()} actual rows (${Math.round(actualRows / planRows)}x off). Table statistics are likely stale.`,
        suggestion: `ANALYZE ${table};`,
        severity: 'warning',
      });
    }
  });

  return diagnostics;
}

// ---------------------------------------------------------------------------
// Rule 3: NESTED_LOOP_EXPLOSION
// ---------------------------------------------------------------------------

export function checkNestedLoopExplosion(
  plan: ExplainNode,
  query: string
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  walkNodes(plan, (node) => {
    if (node['Node Type'] === 'Nested Loop') {
      const loops = node['Actual Loops'] ?? 1;
      const rows = node['Actual Rows'] ?? 0;
      if (loops * rows > 50_000) {
        const innerTable = findInnerRelation(node);
        const joinCol = extractJoinColumn(node);
        diagnostics.push({
          rule: 'NESTED_LOOP_EXPLOSION',
          table: innerTable,
          query,
          detail: `Nested Loop produced ${(loops * rows).toLocaleString()} rows (${loops.toLocaleString()} loops x ${rows.toLocaleString()} rows). Consider adding an index on the inner relation to reduce loop cost.`,
          suggestion: `CREATE INDEX idx_${innerTable}_join ON ${innerTable} (${joinCol});`,
          severity: 'warning',
        });
      }
    }
  });

  return diagnostics;
}

// ---------------------------------------------------------------------------
// Rule 4: DISK_SORT
// ---------------------------------------------------------------------------

export function checkDiskSort(
  plan: ExplainNode,
  query: string
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  walkNodes(plan, (node) => {
    if (
      node['Node Type'] === 'Sort' &&
      typeof node['Sort Method'] === 'string' &&
      node['Sort Method'].toLowerCase().includes('external merge')
    ) {
      const table = node['Relation Name'] || node['Alias'] || '<unknown>';
      diagnostics.push({
        rule: 'DISK_SORT',
        table,
        query,
        detail: `Sort spilled to disk using external merge. This means work_mem is too small to sort the data in-memory.`,
        suggestion: `SET work_mem = '256MB'; -- or increase in postgresql.conf`,
        severity: 'warning',
      });
    }
  });

  return diagnostics;
}

// ---------------------------------------------------------------------------
// Rule 5: SLOW_QUERY
// ---------------------------------------------------------------------------

export function checkSlowQuery(sq: SlowQuery): Diagnostic | null {
  if (sq.meanTime > 500 && sq.calls > 100) {
    return {
      rule: 'SLOW_QUERY',
      table: '-',
      query: sq.query,
      detail: `Query averages ${Math.round(sq.meanTime)}ms over ${sq.calls.toLocaleString()} calls (total: ${Math.round(sq.totalTime / 1000)}s). High frequency + high latency = critical impact.`,
      suggestion: `Review this query for optimization opportunities. Consider caching, query rewriting, or adding indexes.`,
      severity: 'critical',
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Main analysis function
// ---------------------------------------------------------------------------

export function analyzeAll(
  plans: Array<{ slowQuery: SlowQuery; plan: ExplainNode | null }>,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  for (const { slowQuery, plan } of plans) {
    // Rule 5 applies to the query metadata, not the plan
    const slowDiag = checkSlowQuery(slowQuery);
    if (slowDiag) diagnostics.push(slowDiag);

    // Rules 1-4 require a valid EXPLAIN plan
    if (!plan) continue;

    diagnostics.push(...checkSeqScanLarge(plan, slowQuery.query));
    diagnostics.push(...checkBadCardinality(plan, slowQuery.query));
    diagnostics.push(...checkNestedLoopExplosion(plan, slowQuery.query));
    diagnostics.push(...checkDiskSort(plan, slowQuery.query));
  }

  return diagnostics;
}
