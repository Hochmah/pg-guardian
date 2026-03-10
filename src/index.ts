#!/usr/bin/env node

import { Command } from 'commander';
import { Client } from 'pg';
import chalk from 'chalk';
import { collectSlowQueries, PgStatStatementsNotActiveError } from './collector';
import { explainQuery } from './planner';
import { analyzeAll } from './analyzer';
import { printReport } from './reporter';

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
        plan: Awaited<ReturnType<typeof explainQuery>>;
      }> = [];

      for (const sq of slowQueries) {
        const plan = await explainQuery(client, sq.query);
        plans.push({ slowQuery: sq, plan });
      }

      const explained = plans.filter((p) => p.plan !== null).length;
      console.log(chalk.gray(`Successfully explained ${explained}/${slowQueries.length} queries.\n`));

      // Step 3: Analyze
      const diagnostics = analyzeAll(plans);

      // Step 4: Report
      printReport(diagnostics);
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
