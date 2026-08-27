// SPDX-License-Identifier: GPL-3.0-only
import path from 'node:path';
import {
  MarketplaceNotConfiguredError,
  TosRequiredError,
  type CrawlStats,
  type MarketplaceId,
} from '../../crawler/adapter.js';
import { createAdapter } from '../../crawler/adapters/index.js';
import { FixtureAdapter } from '../../crawler/adapters/fixture.js';
import {
  toRawReviewNdjson,
  writeManifest,
  writeReviewsNdjson,
  type RawReviewNdjson,
} from '../../crawler/persist/ndjson.js';
import { loadEnv } from '../../shared/env.js';
import { createLogger } from '../../shared/logger.js';
import {
  newUuid,
  printPipelineRunId,
  RunIdError,
  writeLatestRun,
} from '../../shared/run-id.js';

const ADAPTERS = new Set<MarketplaceId>(['fixture', 'json_api']);

export type CrawlCliOptions = {
  adapter?: string;
  input?: string;
  outDir?: string;
  marketplace?: string;
  storeId?: string[];
  dryRun?: boolean;
  iAcceptTos?: boolean;
  maxReviews?: string;
  strict?: boolean;
  pipelineRunId?: string;
  continueLatest?: boolean;
};

export type RunCrawlOptions = CrawlCliOptions & {
  cwd?: string;
  latestPath?: string;
  env?: NodeJS.ProcessEnv;
  jsonApiConfigDir?: string;
  now?: Date;
  stdout?: { write(chunk: string): unknown };
};

export type CrawlCommandResult = {
  exitCode: number;
  stats: CrawlStats | null;
  pipeline_run_id?: string;
  crawl_batch_id?: string;
  outFile?: string;
  samples: RawReviewNdjson[];
  n_written: number;
  n_deduped: number;
};

function parseAdapter(value: string | undefined): MarketplaceId {
  const id = value ?? 'fixture';
  if (!ADAPTERS.has(id as MarketplaceId)) {
    throw new Error(`unknown --adapter ${id} (expected fixture|json_api)`);
  }
  return id as MarketplaceId;
}

function parseMaxReviews(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const n = Number.parseInt(value, 10);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error('--max-reviews must be a non-negative integer');
  }
  return n;
}

export async function runCrawl(opts: RunCrawlOptions): Promise<CrawlCommandResult> {
  if (opts.pipelineRunId !== undefined && opts.continueLatest === true) {
    throw new RunIdError('--pipeline-run-id and --continue-latest are mutually exclusive');
  }

  const adapterId = parseAdapter(opts.adapter);
  const dryRun = opts.dryRun === true;
  if (adapterId === 'json_api') {
    if (opts.iAcceptTos !== true) {
      throw new TosRequiredError();
    }
    if (opts.marketplace === undefined || opts.marketplace.length === 0) {
      throw new Error('json_api requires --marketplace <id>');
    }
  }
  const loaded = loadEnv({
    command: 'crawl',
    dryRun,
    ...(opts.env === undefined ? {} : { env: opts.env }),
  });
  const salt = loaded.hmac.REVIEWER_ID_SALT;
  const maxReviews = parseMaxReviews(opts.maxReviews);
  const cwd = opts.cwd ?? process.cwd();
  const adapter =
    opts.jsonApiConfigDir === undefined
      ? createAdapter(adapterId, salt)
      : createAdapter(adapterId, salt, opts.jsonApiConfigDir);
  const started_at = (opts.now ?? new Date()).toISOString();

  const reviews: RawReviewNdjson[] = [];
  const crawl_batch_id = newUuid();
  const pipeline_run_id = opts.pipelineRunId ?? newUuid();
  const ingested_at = opts.now ?? new Date();

  const crawlOpts = {
    dryRun,
    iAcceptTos: opts.iAcceptTos === true,
    ...(opts.input === undefined ? {} : { inputPath: opts.input }),
    ...(opts.storeId === undefined ? {} : { storeIds: opts.storeId }),
    ...(maxReviews === undefined ? {} : { maxReviews }),
    ...(opts.marketplace === undefined ? {} : { marketplaceId: opts.marketplace }),
  };

  for await (const review of adapter.crawl(crawlOpts)) {
    reviews.push(
      toRawReviewNdjson(review, {
        crawl_batch_id,
        pipeline_run_id,
        ingested_at,
      }),
    );
  }

  const stats = adapter instanceof FixtureAdapter ? adapter.stats : null;
  const samples = reviews.slice(0, 3);
  const stdout = opts.stdout ?? process.stdout;

  if (dryRun) {
    const n_read = stats?.n_read ?? reviews.length;
    const n_accepted = stats?.n_accepted ?? reviews.length;
    const n_rejected = stats?.n_rejected ?? 0;
    stdout.write(`n_read=${String(n_read)} n_accepted=${String(n_accepted)} n_rejected=${String(n_rejected)}\n`);
    samples.forEach((row, i) => {
      stdout.write(`sample_${String(i + 1)}=${JSON.stringify(row)}\n`);
    });
    const exitCode = opts.strict === true && n_rejected > 0 ? 1 : 0;
    return {
      exitCode,
      stats,
      samples,
      n_written: 0,
      n_deduped: 0,
    };
  }

  const outDir = opts.outDir ?? path.join(cwd, 'data', 'batches', crawl_batch_id);
  const outFile = path.join(outDir, 'reviews.ndjson');
  const { n_written, n_deduped } = writeReviewsNdjson(outFile, reviews);
  const finished_at = new Date().toISOString();
  writeManifest(path.join(outDir, 'manifest.json'), {
    adapter: adapterId,
    input: opts.input ?? null,
    crawl_batch_id,
    pipeline_run_id,
    n_read: stats?.n_read ?? reviews.length,
    n_accepted: stats?.n_accepted ?? reviews.length,
    n_rejected: stats?.n_rejected ?? 0,
    n_written,
    n_deduped,
    started_at,
    finished_at,
  });

  const latestPath = opts.latestPath ?? path.join(cwd, 'data', 'runs', 'latest');
  writeLatestRun(
    {
      pipeline_run_id,
      crawl_batch_id,
      phase: 'crawl',
      started_at,
    },
    latestPath,
  );
  printPipelineRunId(pipeline_run_id, stdout);

  const n_rejected = stats?.n_rejected ?? 0;
  const exitCode = opts.strict === true && n_rejected > 0 ? 1 : 0;
  createLogger(loaded.hmac.LOG_LEVEL).info({
    pipeline_run_id,
    crawl_batch_id,
    n_written,
    n_deduped,
    n_rejected,
    adapter: adapterId,
  });

  return {
    exitCode,
    stats,
    pipeline_run_id,
    crawl_batch_id,
    outFile,
    samples,
    n_written,
    n_deduped,
  };
}

export async function crawlAction(opts: CrawlCliOptions): Promise<void> {
  try {
    const result = await runCrawl(opts);
    if (result.exitCode !== 0) {
      process.exitCode = result.exitCode;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${message}\n`);
    if (
      err instanceof TosRequiredError ||
      err instanceof MarketplaceNotConfiguredError ||
      err instanceof RunIdError
    ) {
      process.exitCode = err.exitCode;
      return;
    }
    process.exitCode = 1;
  }
}
