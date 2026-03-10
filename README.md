# pg-guardian

Catch slow PostgreSQL queries before they hit production.

A CLI that connects to your database, analyzes recently executed queries via `pg_stat_statements`, runs `EXPLAIN ANALYZE` on the slowest ones, and tells you exactly what to fix.

## Why this exists

Developers often discover slow queries only after deployment. `EXPLAIN` plans are hard to interpret. Missing indexes are easy to overlook. Stale statistics go unnoticed until latency spikes.

**pg-guardian** automates the diagnosis: connect, analyze, get actionable suggestions.

## Demo

```text
$ pg-guardian analyze --conn "postgresql://user:pass@localhost:5432/mydb"

Connected to database.
Collecting top 20 slow queries from pg_stat_statements...
Found 20 queries. Running EXPLAIN on each...

  pg-guardian found 3 issue(s):

⚠  [SLOW_QUERY]
   Query: SELECT o.*, u.name FROM orders o JOIN users u ON u.id = o.user_id WHERE o.status = $1 ...
   Detalhe: Query averages 842ms over 12,430 calls (total: 10,474s). High frequency + high latency = critical impact.
   Sugestão: Review this query for optimization opportunities. Consider caching, query rewriting, or adding indexes.

⚠  [SEQ_SCAN_LARGE] — table: orders
   Query: SELECT * FROM orders WHERE created_at > $1 AND status = $2
   Detalhe: Sequential scan on "orders" with ~2,340,000 estimated rows and a filter on "status". An index could eliminate the full table scan.
   Sugestão: CREATE INDEX idx_orders_status ON orders (status);

⚠  [BAD_CARDINALITY] — table: products
   Query: SELECT * FROM products WHERE category_id = 7 AND active = true
   Detalhe: Planner estimated 50 rows but got 12,345 actual rows (247x off). Table statistics are likely stale.
   Sugestão: ANALYZE products;
```

## Features

- **SEQ_SCAN_LARGE** — Detects sequential scans on tables with 100k+ rows where an index would help
- **BAD_CARDINALITY** — Flags nodes where actual rows exceed estimates by 10x (stale statistics)
- **NESTED_LOOP_EXPLOSION** — Catches nested loops producing 50k+ row iterations
- **DISK_SORT** — Identifies sorts spilling to disk via external merge
- **SLOW_QUERY** — Marks queries averaging >500ms with 100+ calls as critical

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
4. Apply 5 performance heuristics
5. Print actionable diagnostics with suggested fixes

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
                              │
                     Colored terminal report
```

1. **Collector** reads `pg_stat_statements` ordered by average execution time
2. **Planner** runs `EXPLAIN` on each query (handles parameterized queries and DML safely)
3. **Analyzer** walks the plan tree and applies each heuristic rule
4. **Reporter** prints diagnostics with severity, details, and exact SQL suggestions

No ORMs. No LLMs. No magic. Just deterministic rules applied to real execution plans.

## Contributing

Contributions are welcome. To add a new performance rule:

1. Add your check function in `src/analyzer.ts` following the existing pattern
2. Use `walkNodes()` to traverse the EXPLAIN plan tree
3. Return a `Diagnostic` with rule name, detail, and actionable suggestion
4. Wire it into `analyzeAll()`

## License

MIT
