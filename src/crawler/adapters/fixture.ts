// SPDX-License-Identifier: GPL-3.0-only
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import {
  emptyCrawlStats,
  type CrawlOptions,
  type CrawlStats,
  type MarketplaceAdapter,
  type NormalizedReview,
} from '../adapter.js';
import { normalizeFixtureReview } from '../normalize.js';
import { parseFixtureReviewLine, zodFailureIsStarRating } from '../types.js';

export class FixtureAdapter implements MarketplaceAdapter {
  readonly id = 'fixture' as const;
  readonly stats: CrawlStats = emptyCrawlStats();

  constructor(private readonly salt: string) {}

  async *crawl(opts: CrawlOptions): AsyncIterable<NormalizedReview> {
    if (opts.inputPath === undefined || opts.inputPath.length === 0) {
      throw new Error('fixture adapter requires --input <jsonl>');
    }

    const storeFilter =
      opts.storeIds !== undefined && opts.storeIds.length > 0 ? new Set(opts.storeIds) : null;
    const productFilter =
      opts.productIds !== undefined && opts.productIds.length > 0
        ? new Set(opts.productIds)
        : null;

    const rl = createInterface({
      input: createReadStream(opts.inputPath, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });

    try {
      for await (const rawLine of rl) {
        const line = rawLine.trim();
        if (line.length === 0) {
          continue;
        }
        this.stats.n_read += 1;

        const parsed = parseFixtureReviewLine(line);
        if (!parsed.success) {
          this.stats.n_rejected += 1;
          if (parsed.reason === 'json') {
            this.stats.n_rejected_json += 1;
          } else {
            this.stats.n_rejected_zod += 1;
            if (zodFailureIsStarRating(line)) {
              this.stats.n_rejected_star += 1;
            }
          }
          continue;
        }

        const raw = parsed.data;
        if (storeFilter !== null && !storeFilter.has(raw.store_id)) {
          this.stats.n_filtered += 1;
          continue;
        }
        if (productFilter !== null && !productFilter.has(raw.product_id)) {
          this.stats.n_filtered += 1;
          continue;
        }

        const review = normalizeFixtureReview(raw, this.salt);
        if (opts.since !== undefined && review.review_ts < opts.since) {
          this.stats.n_filtered += 1;
          continue;
        }
        if (opts.until !== undefined && review.review_ts > opts.until) {
          this.stats.n_filtered += 1;
          continue;
        }

        if (opts.maxReviews !== undefined && this.stats.n_accepted >= opts.maxReviews) {
          break;
        }

        this.stats.n_accepted += 1;
        yield review;
      }
    } finally {
      rl.close();
    }
  }
}
