# pg-guardian

Catch slow PostgreSQL queries before they hit production.

A CLI that connects to your database, analyzes recently executed queries via `pg_stat_statements`, runs `EXPLAIN ANALYZE` on the slowest ones, and flags likely performance issues with suggestions for where to investigate.

## Why this exists

Developers often discover slow queries only after deployment. `EXPLAIN` plans are hard to interpret. Missing indexes are easy to overlook. Stale statistics go unnoticed until latency spikes.

**pg-guardian** automates the triage: connect, analyze, get diagnostic suggestions to guide your investigation.

## Demo

```text
$ pg-guardian analyze --conn "postgresql://user:pass@localhost:5432/mydb"

Connected to database.
Collecting top 20 slow queries from pg_stat_statements...
Found 20 queries. Running EXPLAIN on each...
Successfully explained 17/20 queries.

  pg-guardian found 3 issue(s):

⚠  [SLOW_QUERY] [high confidence]
   Query: SELECT o.*, u.name FROM orders o JOIN users u ON u.id = o.user_id WHERE o.status = $1 ...
   Detalhe: Query averages 842ms over 12,430 calls (total: 10,474s). High frequency + high latency = critical impact.
   Sugestão: Review this query for optimization opportunities. Consider caching, query rewriting, or adding indexes.

⚠  [SEQ_SCAN_LARGE] — table: orders [high confidence]
   Query: SELECT * FROM orders WHERE status = 'pending'
   Detalhe: Sequential scan on "orders" with ~2,340,000 estimated rows and filter on "status".
   Sugestão: CREATE INDEX idx_orders_status ON orders (status);

⚠  [BAD_CARDINALITY] — table: products [high confidence]
   Query: SELECT * FROM products WHERE category_id = 7 AND active = true
   Detalhe: Planner underestimated: expected 50 rows but got 12,345 actual rows (247x off). Table statistics are likely stale.
   Sugestão: ANALYZE products;

  ℹ  3 query(ies) could not be analyzed:

     • "SET statement_timeout = $1" — prepared statement does not exist
     • "COPY data FROM STDIN" — syntax error at or near "COPY"
```

## Features

- **SEQ_SCAN_LARGE** — Detects sequential scans on tables with 100k+ rows where an index would help. Checks existing indexes to avoid duplicates.
- **BAD_CARDINALITY** — Flags nodes where actual rows differ from estimates by 10x in either direction (stale statistics).
- **NESTED_LOOP_EXPLOSION** — Catches nested loops producing 50k+ row iterations. Checks if join column is already indexed.
- **DISK_SORT** — Identifies sorts spilling to disk via external merge, with cautious `work_mem` guidance.
- **SLOW_QUERY** — Marks queries averaging >500ms with 100+ calls as critical.

Each diagnostic includes a **confidence level** (high/medium/low) so you know how much to trust the suggestion.

## Installation

```bash
npm install -g pg-guardian
```

Or run directly:

```bash
npx ts-node src/index.ts analyze --conn "postgresql://user:pass@localhost:5432/mydb"
```

## Usage

```bash
pg-guardian analyze --conn "postgresql://user:pass@localhost:5432/mydb"
```

The tool will:
1. Connect to your PostgreSQL database
2. Read the top 20 slowest queries from `pg_stat_statements`
3. Run `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` on each
4. Check existing indexes via `pg_indexes`
5. Apply 5 performance heuristics with confidence scoring
6. Print diagnostics with suggested fixes
7. List any queries that could not be analyzed (with reasons)

### Prerequisites

Your database must have `pg_stat_statements` enabled. If it's not, pg-guardian will tell you how to set it up:

```text
Error: pg_stat_statements extension is not available.

To enable it:
  1. Add to postgresql.conf:
     shared_preload_libraries = 'pg_stat_statements'
  2. Restart PostgreSQL
  3. Run in your database:
     CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
```

## How it works

```
pg_stat_statements ──→ Top 20 by mean_exec_time
                              │
                    EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
                              │
                     Recursive plan tree walk
                              │
                    5 deterministic heuristics
                       + index existence check
                       + confidence scoring
                              │
                     Colored terminal report
```

1. **Collector** reads `pg_stat_statements` ordered by average execution time
2. **Planner** runs `EXPLAIN` on each query (handles parameterized queries and DML safely). Reports failures instead of silently swallowing them.
3. **Analyzer** walks the plan tree, checks existing indexes, and applies each heuristic with a confidence level. Parameterized queries (estimated-only plans) skip rules that need actual execution data.
4. **Reporter** prints diagnostics with severity, confidence, details, and SQL suggestions. Lists queries that could not be analyzed.

No ORMs. No LLMs. No magic. Just deterministic rules applied to real execution plans.

## Limitations

- Parameterized queries (`$1`, `$2`) are explained without `ANALYZE`, so some heuristics (BAD_CARDINALITY, NESTED_LOOP_EXPLOSION) are skipped for them.
- Index suggestions for complex multi-column filters are marked as low confidence — always review before applying.
- The tool reads query plans, not actual production traffic patterns.

## Contributing

Contributions are welcome. To add a new performance rule:

1. Add your check function in `src/analyzer.ts` following the existing pattern
2. Use `walkNodes()` to traverse the EXPLAIN plan tree
3. Return a `Diagnostic` with rule name, detail, suggestion, and confidence level
4. Wire it into `analyzeAll()`

## License

MIT
