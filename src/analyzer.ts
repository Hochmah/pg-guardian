import { ExplainNode } from './planner';
import { SlowQuery } from './collector';

export interface Diagnostic {
  rule: string;
  table: string;
  query: string;
  detail: string;
  suggestion: string;
  severity: 'warning' | 'critical';
  confidence: 'high' | 'medium' | 'low';
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
// Helper: extract column names from a Filter expression
// ---------------------------------------------------------------------------

function extractFilterColumns(filter: string): string[] {
  // Remove outer parens and type casts like ::text
  const cleaned = filter.replace(/::\w+/g, '');
  // Split on AND / OR to find multiple conditions
  const parts = cleaned.split(/\bAND\b|\bOR\b/i);
  const columns: string[] = [];
  for (const part of parts) {
    // Match patterns like (column_name), table.column, or bare column_name before operator
    const match = part.match(/\((\w+)\)/) || part.match(/(\w+)\.(\w+)/) || part.match(/(\w+)\s*[=<>!]/);
    if (match) {
      const col = match[2] || match[1];
      if (col && !columns.includes(col)) {
        columns.push(col);
      }
    }
  }
  return columns.length > 0 ? columns : ['<unknown column>'];
}

// ---------------------------------------------------------------------------
// Helper: check if a column is already indexed
// ---------------------------------------------------------------------------

function isColumnIndexed(
  column: string,
  indexDefs: string[]
): boolean {
  const colLower = column.toLowerCase();
  return indexDefs.some((def) => {
    const lower = def.toLowerCase();
    // Match column in index definition: (column) or (column, ...) or (..., column)
    return (
      lower.includes(`(${colLower})`) ||
      lower.includes(`(${colLower},`) ||
      lower.includes(`, ${colLower})`) ||
      lower.includes(`, ${colLower},`)
    );
  });
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
  const match = String(cond).match(/(\w+)\.(\w+)\s*=\s*(\w+)\.(\w+)/);
  if (match) return match[4];
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
  query: string,
  indexesByTable: Map<string, string[]>,
  estimated: boolean
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  walkNodes(plan, (node) => {
    if (
      node['Node Type'] === 'Seq Scan' &&
      node['Plan Rows'] > 100_000 &&
      node['Filter']
    ) {
      const table = node['Relation Name'] || node['Alias'] || '<unknown>';
      const columns = extractFilterColumns(node['Filter']);
      const tableIndexes = indexesByTable.get(table) || [];
      const isMultiColumn = columns.length > 1;

      // Check if all filter columns are already indexed
      const allIndexed = columns.every((col) =>
        col !== '<unknown column>' && isColumnIndexed(col, tableIndexes)
      );
      if (allIndexed) return;

      const unindexedCols = columns.filter(
        (col) => col !== '<unknown column>' && !isColumnIndexed(col, tableIndexes)
      );

      let confidence: 'high' | 'medium' | 'low';
      let suggestion: string;
      let detailSuffix = '';

      if (isMultiColumn) {
        confidence = 'low';
        detailSuffix = ' Complex filter detected — manual review recommended.';
        suggestion = `-- Consider a composite index:\nCREATE INDEX idx_${table}_composite ON ${table} (${unindexedCols.join(', ')});`;
      } else {
        confidence = 'high';
        const col = unindexedCols[0] || columns[0];
        suggestion = `CREATE INDEX idx_${table}_${col} ON ${table} (${col});`;
      }

      if (estimated) {
        detailSuffix += ' (Plan based on estimates only — parameterized query)';
        if (confidence === 'high') confidence = 'medium';
      }

      diagnostics.push({
        rule: 'SEQ_SCAN_LARGE',
        table,
        query,
        detail: `Sequential scan on "${table}" with ~${node['Plan Rows'].toLocaleString()} estimated rows and filter on ${columns.map((c) => `"${c}"`).join(', ')}.${detailSuffix}`,
        suggestion,
        severity: 'warning',
        confidence,
      });
    }
  });

  return diagnostics;
}

// ---------------------------------------------------------------------------
// Rule 2: BAD_CARDINALITY (bidirectional)
// ---------------------------------------------------------------------------

export function checkBadCardinality(
  plan: ExplainNode,
  query: string
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  walkNodes(plan, (node) => {
    const actualRows = node['Actual Rows'];
    const actualLoops = node['Actual Loops'] ?? 1;
    const planRows = node['Plan Rows'];

    if (actualRows === undefined || planRows <= 0) return;

    const totalActual = actualRows * actualLoops;
    const totalPlanned = planRows; // Plan Rows is already per-loop in PG

    // Underestimate: actual >> planned
    if (totalActual > 10 * totalPlanned) {
      const table = node['Relation Name'] || node['Alias'] || '<unknown>';
      const ratio = Math.round(totalActual / totalPlanned);
      diagnostics.push({
        rule: 'BAD_CARDINALITY',
        table,
        query,
        detail: `Planner underestimated: expected ${totalPlanned.toLocaleString()} rows but got ${totalActual.toLocaleString()} actual rows (${ratio}x off). Table statistics are likely stale.`,
        suggestion: `ANALYZE ${table};`,
        severity: 'warning',
        confidence: 'high',
      });
    }

    // Overestimate: planned >> actual
    if (totalActual > 0 && totalPlanned > 10 * totalActual) {
      const table = node['Relation Name'] || node['Alias'] || '<unknown>';
      const ratio = Math.round(totalPlanned / totalActual);
      diagnostics.push({
        rule: 'BAD_CARDINALITY',
        table,
        query,
        detail: `Planner overestimated: expected ${totalPlanned.toLocaleString()} rows but got ${totalActual.toLocaleString()} actual rows (${ratio}x off). This can cause suboptimal join strategies.`,
        suggestion: `ANALYZE ${table};`,
        severity: 'warning',
        confidence: 'high',
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
  query: string,
  indexesByTable: Map<string, string[]>
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  walkNodes(plan, (node) => {
    if (node['Node Type'] === 'Nested Loop') {
      const loops = node['Actual Loops'] ?? 1;
      const rows = node['Actual Rows'] ?? 0;
      if (loops * rows > 50_000) {
        const innerTable = findInnerRelation(node);
        const joinCol = extractJoinColumn(node);
        const tableIndexes = indexesByTable.get(innerTable) || [];

        // Skip if join column is already indexed
        if (joinCol !== '<join column>' && isColumnIndexed(joinCol, tableIndexes)) {
          return;
        }

        diagnostics.push({
          rule: 'NESTED_LOOP_EXPLOSION',
          table: innerTable,
          query,
          detail: `Nested Loop produced ${(loops * rows).toLocaleString()} rows (${loops.toLocaleString()} loops x ${rows.toLocaleString()} rows). Consider adding an index on the inner relation to reduce loop cost.`,
          suggestion: `CREATE INDEX idx_${innerTable}_${joinCol} ON ${innerTable} (${joinCol});`,
          severity: 'warning',
          confidence: joinCol === '<join column>' ? 'low' : 'medium',
        });
      }
    }
  });

  return diagnostics;
}

// ---------------------------------------------------------------------------
// Rule 4: DISK_SORT (cautious recommendation)
// ---------------------------------------------------------------------------

export function checkDiskSort(
  plan: ExplainNode,
  query: string,
  estimated: boolean
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  walkNodes(plan, (node) => {
    if (
      node['Node Type'] === 'Sort' &&
      typeof node['Sort Method'] === 'string' &&
      node['Sort Method'].toLowerCase().includes('external merge')
    ) {
      const table = node['Relation Name'] || node['Alias'] || '<unknown>';
      let detail = 'Sort spilled to disk using external merge. work_mem may be too small for this operation.';
      if (estimated) {
        detail += ' (Plan based on estimates only — parameterized query)';
      }

      diagnostics.push({
        rule: 'DISK_SORT',
        table,
        query,
        detail,
        suggestion:
          'SET work_mem = \'64MB\'; -- test with this query first\n' +
          '   -- WARNING: work_mem is per-operation, not per-query.\n' +
          '   -- Increasing globally affects all concurrent sorts.\n' +
          '   -- Test per-session before changing postgresql.conf.',
        severity: 'warning',
        confidence: 'medium',
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
      suggestion: 'Review this query for optimization opportunities. Consider caching, query rewriting, or adding indexes.',
      severity: 'critical',
      confidence: 'high',
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Main analysis function
// ---------------------------------------------------------------------------

export function analyzeAll(
  plans: Array<{
    slowQuery: SlowQuery;
    plan: ExplainNode | null;
    estimated: boolean;
  }>,
  indexesByTable: Map<string, string[]>
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  for (const { slowQuery, plan, estimated } of plans) {
    // Rule 5 applies to the query metadata, not the plan
    const slowDiag = checkSlowQuery(slowQuery);
    if (slowDiag) diagnostics.push(slowDiag);

    // Rules 1-4 require a valid EXPLAIN plan
    if (!plan) continue;

    // SEQ_SCAN_LARGE works with Plan Rows (ok for estimated)
    diagnostics.push(...checkSeqScanLarge(plan, slowQuery.query, indexesByTable, estimated));

    // BAD_CARDINALITY needs Actual Rows — skip for estimated plans
    if (!estimated) {
      diagnostics.push(...checkBadCardinality(plan, slowQuery.query));
    }

    // NESTED_LOOP_EXPLOSION needs Actual Loops — skip for estimated plans
    if (!estimated) {
      diagnostics.push(...checkNestedLoopExplosion(plan, slowQuery.query, indexesByTable));
    }

    // DISK_SORT uses Sort Method (ok for estimated, though rare without ANALYZE)
    diagnostics.push(...checkDiskSort(plan, slowQuery.query, estimated));
  }

  return diagnostics;
}
