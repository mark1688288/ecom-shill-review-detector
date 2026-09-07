#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command, Option } from 'commander';
import { analyzeAction } from './commands/analyze.js';
import { auditAction } from './commands/audit.js';
import { crawlAction } from './commands/crawl.js';
import { harvestAction } from './commands/harvest.js';
import { layer1Action } from './commands/layer1.js';
import { layer2Action } from './commands/layer2.js';
import { loadAction } from './commands/load.js';
import { reportAction } from './commands/report.js';
import { seedsCalibrateAction, seedsUpsertAction } from './commands/seeds.js';

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
      .addOption(
        new Option('--adapter <id>', 'Marketplace adapter: fixture | json_api')
          .choices(['fixture', 'json_api'])
          .default('fixture'),
      )
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
      .action(crawlAction),
  );

  addRunFlags(
    program
      .command('load')
      .description('Load NDJSON into BigQuery raw_reviews via staging MERGE')
      .option('--ndjson <file>', 'NDJSON file to load')
      .option(
        '--gcs-uri <gs://...>',
        'Staging object URI; if omitted, upload to GCS_STAGING_BUCKET or {GCP_PROJECT}-ecom-shill-staging',
      )
      .addOption(
        new Option('--load-mode <mode>', 'gcs (default) or direct (tests only)')
          .choices(['gcs', 'direct'])
          .default('gcs'),
      )
      .option('--dataset <id>', 'BigQuery dataset (default env BQ_DATASET)'),
  ).action(loadAction);

  addRunFlags(program.command('layer1').description('Materialize stage1_filtered for a pipeline run')).action(
    layer1Action,
  );

  addRunFlags(
    program
      .command('layer2')
      .description('Embed stage1 reviews and filter by cosine distance to PR seed phrases')
      .option('--seed-version <id>', 'Seed version (default: active version or config seed_version)'),
  ).action(layer2Action);

  addRunFlags(
    program
      .command('audit')
      .description('Score stage2 rows with Vertex Gemini Flash (JSON Schema)')
      .option('--concurrency <n>', 'Parallel Gemini calls (5-10, default 8)')
      .option('--limit <n>', 'Max new Gemini calls (non-prod default 100)')
      .option('--skip-existing', 'Copy-forward matching prior assessments (default true)')
      .option('--force-rescore', 'Ignore prior scores and rescore this run\'s stage2 (still --limit)', false),
  ).action(auditAction);

  addRunFlags(
    program.command('analyze').description('Compute store stats, bursts, and cross-store collisions'),
  ).action(analyzeAction);

  addRunFlags(
    program
      .command('report')
      .description('Write markdown or JSON report (includes "statistics ≠ legal facts")')
      .addOption(
        new Option('--format <fmt>', 'markdown | json')
          .choices(['markdown', 'json'])
          .default('markdown'),
      )
      .option('--dot', 'Also write a Graphviz .dot edge list', false)
      .option('--out <path>', 'Output path (default reports/<pipeline_run_id>.md|.json)'),
  ).action(reportAction);

  program
    .command('harvest')
    .description(
      'Harvest public HKTVmall reviews to FixtureReviewRaw JSONL via Bright Data Browser API or ScrapingBee HTML API. harvest does not create pipeline runs; crawl the JSONL afterwards.',
    )
    .addOption(
      new Option('--transport <id>', 'Harvest transport: brightdata (default) | scrapingbee')
        .choices(['brightdata', 'scrapingbee'])
        .default('brightdata'),
    )
    .option('--marketplace <id>', 'Marketplace id (H1 only allows hktvmall)', 'hktvmall')
    .option(
      '--url <https://...>',
      'Public product URL (repeatable)',
      (value: string, previous: string[]) => {
        previous.push(value);
        return previous;
      },
      [] as string[],
    )
    .option('--url-file <path>', 'Local text file with one public product URL per line')
    .option('--out <jsonl>', 'Output JSONL path (default data/harvested/<YYYYMMDDTHHMMSSZ>-hktvmall.jsonl)')
    .option('--i-accept-tos', 'Required for live harvest (operator evaluated ToS / robots / local law)', false)
    .option('--dry-run', 'Validate URLs and print plan_*; no CDP, no files, no creds, no ToS', false)
    .option('--country <iso>', 'ISO country for proxy geo (default HK)', 'HK')
    .option('--max-reviews <n>', 'Cap unique native_review_id across pages')
    .option('--max-pages <n>', 'Max pages to parse per URL (default 20)', '20')
    .option(
      '--goto-timeout-ms <n>',
      'navigation/API timeout (default 120000; ScrapingBee requires 1000–140000)',
      '120000',
    )
    .option(
      '--wrapper-timeout-ms <n>',
      'Bright Data review-tab/wrapper wait (default 30000); ScrapingBee logs only, does not change the 7000ms pager wait',
      '30000',
    )
    .option('--strict', 'Fail when any wrapper is rejected (empty harvest always fails)', false)
    .action(harvestAction);

  const seeds = program
    .command('seeds')
    .description('Upsert PR seed phrases or sweep cosine-distance thresholds (Phase 5)');

  seeds
    .command('upsert')
    .description(
      'INSERT a new seed_version into pr_seed_phrases (does not overwrite older versions)',
    )
    .requiredOption('--input <path>', 'JSONL or JSON array of the 7 category slots')
    .requiredOption('--seed-version <id>', 'New seed_version (not v0_hypothesis)')
    .option('--no-activate', 'Leave other seed_versions active')
    .option('--dry-run', 'Validate input and print plan_*; no BigQuery', false)
    .action(seedsUpsertAction);

  seeds
    .command('calibrate')
    .description('Sweep cosine-distance thresholds against human_labels for a pipeline run')
    .option('--pipeline-run-id <uuid>', 'Pipeline run id (mutually exclusive with --continue-latest)')
    .option('--continue-latest', 'Read pipeline_run_id from data/runs/latest')
    .option('--label-file <jsonl>', 'Upsert labels for this run before the sweep')
    .option('--dry-run', 'Validate --label-file and print plan_*; no BigQuery', false)
    .action(seedsCalibrateAction);

  return program;
}

function isCliEntrypoint(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) {
    return false;
  }
  const self = fileURLToPath(import.meta.url);
  const resolved = path.resolve(entry);
  return resolved === self || path.basename(resolved) === path.basename(self);
}

if (isCliEntrypoint()) {
  buildProgram().parse(argvWithoutPnpmSeparator(process.argv));
}
