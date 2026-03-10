#!/usr/bin/env node

import { Command } from 'commander';
import { Client } from 'pg';
import chalk from 'chalk';
import { collectSlowQueries, fetchTableIndexes, PgStatStatementsNotActiveError } from './collector';
import { explainQuery, ExplainNode } from './planner';
import { analyzeAll } from './analyzer';
import { printReport, printSkippedQueries, SkippedQuery } from './reporter';

const program = new Command();

program
  .name('pg-guardian')
  .description('Analyze PostgreSQL query performance via pg_stat_statements')
  .version('1.0.0');

program
  .command('analyze')
  .description('Collect slow queries, run EXPLAIN, and report diagnostics')
  .requiredOption('--conn <connection_string>', 'PostgreSQL connection string')
  .action(async (opts: { conn: string }) => {
    const client = new Client({ connectionString: opts.conn });

    try {
      await client.connect();
      console.log(chalk.gray('Connected to database.\n'));

      // Step 1: Collect slow queries
      console.log(chalk.gray('Collecting top 20 slow queries from pg_stat_statements...'));
      const slowQueries = await collectSlowQueries(client);

      if (slowQueries.length === 0) {
        console.log(chalk.yellow('\nNo queries found in pg_stat_statements. The database may be freshly started or have no recorded activity.\n'));
        return;
      }

      console.log(chalk.gray(`Found ${slowQueries.length} queries. Running EXPLAIN on each...\n`));

      // Step 2: EXPLAIN each query
      const plans: Array<{
        slowQuery: (typeof slowQueries)[number];
        plan: ExplainNode | null;
        estimated: boolean;
      }> = [];
      const skipped: SkippedQuery[] = [];

      for (const sq of slowQueries) {
        const outcome = await explainQuery(client, sq.query);
        if (outcome.ok) {
          plans.push({ slowQuery: sq, plan: outcome.plan, estimated: outcome.estimated });
        } else {
          plans.push({ slowQuery: sq, plan: null, estimated: false });
          skipped.push({ query: sq.query, reason: outcome.reason });
        }
      }

      const explained = plans.filter((p) => p.plan !== null).length;
      console.log(chalk.gray(`Successfully explained ${explained}/${slowQueries.length} queries.\n`));

      // Step 3: Collect existing indexes for tables found in plans
      const tableNames = new Set<string>();
      for (const { plan } of plans) {
        if (!plan) continue;
        const collectTables = (node: ExplainNode): void => {
          if (node['Relation Name']) tableNames.add(node['Relation Name']);
          if (node.Plans) node.Plans.forEach(collectTables);
        };
        collectTables(plan);
      }

      const indexesByTable = new Map<string, string[]>();
      for (const table of tableNames) {
        try {
          const indexes = await fetchTableIndexes(client, table);
          indexesByTable.set(table, indexes);
        } catch {
          // If we can't fetch indexes for a table, just skip the check
          indexesByTable.set(table, []);
        }
      }

      // Step 4: Analyze
      const diagnostics = analyzeAll(plans, indexesByTable);

      // Step 5: Report
      printReport(diagnostics);
      printSkippedQueries(skipped);
    } catch (err) {
      if (err instanceof PgStatStatementsNotActiveError) {
        console.error(chalk.red(`\nError: ${err.message}`));
      } else if (err instanceof Error) {
        console.error(chalk.red(`\nConnection error: ${err.message}`));
      } else {
        console.error(chalk.red('\nUnknown error occurred.'));
      }
      process.exitCode = 1;
    } finally {
      await client.end().catch(() => {});
    }
  });

program.parse();
