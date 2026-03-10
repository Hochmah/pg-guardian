import chalk from 'chalk';
import { Diagnostic } from './analyzer';

function truncate(str: string, maxLen: number): string {
  const oneLine = str.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= maxLen) return oneLine;
  return oneLine.slice(0, maxLen - 3) + '...';
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

    console.log(`${icon}  ${ruleBadge}${tableLabel}`);
    console.log(`   Query: ${chalk.gray(truncate(d.query, 120))}`);
    console.log(`   Detalhe: ${d.detail}`);
    console.log(`   Sugestão: ${chalk.green(d.suggestion)}`);
    console.log();
  }
}
