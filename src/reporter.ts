import chalk from 'chalk';
import { Diagnostic } from './analyzer';

export interface SkippedQuery {
  query: string;
  reason: string;
}

function truncate(str: string, maxLen: number): string {
  const oneLine = str.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= maxLen) return oneLine;
  return oneLine.slice(0, maxLen - 3) + '...';
}

function confidenceBadge(confidence: 'high' | 'medium' | 'low'): string {
  switch (confidence) {
    case 'high':
      return chalk.green('[high confidence]');
    case 'medium':
      return chalk.yellow('[medium confidence]');
    case 'low':
      return chalk.red('[low confidence]');
  }
}

export function printReport(diagnostics: Diagnostic[]): void {
  if (diagnostics.length === 0) {
    console.log(chalk.green('\n✓ No performance issues detected.\n'));
    return;
  }

  console.log(
    chalk.bold(`\n  pg-guardian found ${diagnostics.length} issue(s):\n`)
  );

  for (const d of diagnostics) {
    const icon =
      d.severity === 'critical'
        ? chalk.red.bold('⚠')
        : chalk.yellow.bold('⚠');
    const ruleBadge =
      d.severity === 'critical'
        ? chalk.red.bold(`[${d.rule}]`)
        : chalk.yellow.bold(`[${d.rule}]`);
    const tableLabel = d.table !== '-' ? ` — table: ${chalk.cyan(d.table)}` : '';

    console.log(`${icon}  ${ruleBadge}${tableLabel} ${confidenceBadge(d.confidence)}`);
    console.log(`   Query: ${chalk.gray(truncate(d.query, 120))}`);
    console.log(`   Detalhe: ${d.detail}`);
    console.log(`   Sugestão: ${chalk.green(d.suggestion)}`);
    console.log();
  }
}

export function printSkippedQueries(skipped: SkippedQuery[]): void {
  if (skipped.length === 0) return;

  console.log(
    chalk.gray(`  ℹ  ${skipped.length} query(ies) could not be analyzed:\n`)
  );

  for (const s of skipped) {
    const shortQuery = truncate(s.query, 80);
    console.log(chalk.gray(`     • "${shortQuery}" — ${s.reason}`));
  }
  console.log();
}
