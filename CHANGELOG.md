# Changelog

## [1.1.0] - 2026-03-10

### Added
- **Confidence levels** on every diagnostic (`high`, `medium`, `low`) so users know how much to trust each suggestion.
- **Existing index checking** via `pg_indexes` — SEQ_SCAN_LARGE and NESTED_LOOP_EXPLOSION no longer suggest indexes that already exist.
- **Bidirectional cardinality detection** — BAD_CARDINALITY now catches both underestimates (actual >> planned) and overestimates (planned >> actual).
- **Skipped queries report** — queries that fail EXPLAIN are listed with reasons instead of being silently dropped.
- **`fetchTableIndexes()`** in collector to query `pg_indexes` per table.
- **Limitations section** in README.

### Changed
- **DISK_SORT** suggestion reduced from `256MB` to `64MB` with explicit warning that `work_mem` is per-operation, not per-query.
- **Parameterized queries** now marked as `estimated: true` — rules that depend on actual execution data (BAD_CARDINALITY, NESTED_LOOP_EXPLOSION) are skipped for them.
- **`explainQuery()`** returns typed `ExplainOutcome` (success with plan + estimated flag, or failure with reason) instead of `ExplainNode | null`.
- **`extractFilterColumns()`** now returns an array of columns, handling AND/OR multi-column filters.
- **Multi-column filters** emit diagnostics with `confidence: 'low'` and a note to review manually.
- **README** calibrated: "tells you exactly what to fix" replaced with "flags likely performance issues and suggests where to investigate".

## [1.0.0] - 2026-03-10

### Added
- Initial release.
- CLI command: `pg-guardian analyze --conn <connection_string>`.
- Collector: reads top 20 slow queries from `pg_stat_statements` ordered by `mean_exec_time`.
- Planner: runs `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` with safe handling for parameterized queries and DML.
- 5 deterministic heuristics: SEQ_SCAN_LARGE, BAD_CARDINALITY, NESTED_LOOP_EXPLOSION, DISK_SORT, SLOW_QUERY.
- Colored terminal output via chalk.
- Error detection for missing `pg_stat_statements` extension with setup instructions.
