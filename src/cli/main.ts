#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only
import { Command, Option } from 'commander';

function notImplemented(commandName: string): () => never {
  return () => {
    process.stderr.write(`${commandName}: not implemented\n`);
    process.exit(2);
  };
}

function addRunFlags(cmd: Command): Command {
  return cmd
    .option('--pipeline-run-id <uuid>', 'Pipeline run id (mutually exclusive with --continue-latest)')
    .option('--continue-latest', 'Read pipeline_run_id from data/runs/latest')
    .option('--resume', 'Resume a run whose heartbeat expired (>15 min) or when forced', false)
    .option('--i-am-prod', 'Treat this process as prod (disables non-prod audit --limit default)', false)
    .option('--strict', 'Fail crawl on any fixture row Zod error', false);
}

/**
 * `pnpm run cli -- --help` (and pnpm 9's script wrapper) inserts a literal `--`
 * before user args. Commander treats everything after `--` as operands, so
 * `--help` becomes an unknown command. Drop the first separator after argv[1].
 */
export function argvWithoutPnpmSeparator(argv: readonly string[]): string[] {
  const result = [...argv];
  const sepIndex = result.indexOf('--', 2);
  if (sepIndex !== -1) {
    result.splice(sepIndex, 1);
  }
  return result;
}

export function buildProgram(): Command {
  const program = new Command();

  program
    .name('ecom-shill')
    .description(
      'Cantonese e-commerce shill review detector. Fixture-first personal research tool. Statistics are not legal facts.',
    )
    .version('0.1.0');

  addRunFlags(
    program
      .command('crawl')
      .description('Replay fixture reviews to NDJSON (does not write BigQuery pipeline_runs)')
      .option('--adapter <id>', 'Marketplace adapter: fixture | json_api', 'fixture')
      .option('--input <jsonl>', 'Fixture JSONL path (required for fixture)')
      .option('--out-dir <dir>', 'NDJSON output directory (default ./data/batches/<crawl_batch_id>)')
      .option('--marketplace <id>', 'json_api marketplace id (Phase 1 is still zero-HTTP)')
      .option('--store-id <id>', 'Store id (repeatable)', (value: string, previous: string[]) => {
        previous.push(value);
        return previous;
      }, [] as string[])
      .option('--dry-run', 'Print counts and 3 sample rows; no files, no GCP', false)
      .option('--i-accept-tos', 'Required for json_api (still no HTTP in v1)', false)
      .option('--max-reviews <n>', 'Maximum reviews to emit')
      .action(notImplemented('crawl')),
  );

  addRunFlags(
    program
      .command('load')
      .description('Load NDJSON into BigQuery raw_reviews via staging MERGE')
      .option('--ndjson <file>', 'NDJSON file to load')
      .option('--gcs-uri <gs://...>', 'Staging object URI; uploaded if omitted and not dry-run')
      .addOption(
        new Option('--load-mode <mode>', 'gcs (default) or direct (tests only)').choices([
          'gcs',
          'direct',
        ]),
      )
      .option('--dataset <id>', 'BigQuery dataset (default env BQ_DATASET)'),
  ).action(notImplemented('load'));

  addRunFlags(program.command('layer1').description('Materialize stage1_filtered for a pipeline run')).action(
    notImplemented('layer1'),
  );

  addRunFlags(
    program
      .command('layer2')
      .description('Embed stage1 reviews and filter by cosine distance to PR seed phrases')
      .option('--seed-version <id>', 'Seed version (default: active version or config seed_version)'),
  ).action(notImplemented('layer2'));

  addRunFlags(
    program
      .command('audit')
      .description('Score stage2 rows with Vertex Gemini Flash (JSON Schema)')
      .option('--concurrency <n>', 'Parallel Gemini calls (5-10, default 8)')
      .option('--limit <n>', 'Max new Gemini calls (non-prod default 100)')
      .option('--skip-existing', 'Copy-forward matching prior assessments (default true)')
      .option('--force-rescore', 'Ignore prior scores and rescore this run\'s stage2 (still --limit)', false),
  ).action(notImplemented('audit'));

  addRunFlags(
    program.command('analyze').description('Compute store stats, bursts, and cross-store collisions'),
  ).action(notImplemented('analyze'));

  addRunFlags(
    program
      .command('report')
      .description('Write markdown or JSON report (includes "statistics ≠ legal facts")')
      .option('--format <fmt>', 'markdown | json', 'markdown')
      .option('--dot', 'Also write a Graphviz .dot edge list', false)
      .option('--out <path>', 'Output path (default reports/<pipeline_run_id>.md|.json)'),
  ).action(notImplemented('report'));

  program
    .command('seeds')
    .description('Upsert PR seed phrases (Phase 5)')
    .action(notImplemented('seeds'));

  return program;
}

buildProgram().parse(argvWithoutPnpmSeparator(process.argv));
