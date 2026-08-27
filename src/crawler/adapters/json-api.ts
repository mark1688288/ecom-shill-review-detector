// SPDX-License-Identifier: GPL-3.0-only
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import {
  MarketplaceNotConfiguredError,
  TosRequiredError,
  type CrawlOptions,
  type MarketplaceAdapter,
  type NormalizedReview,
} from '../adapter.js';

const DEFAULT_MARKETPLACE_CONFIG_DIR = fileURLToPath(
  new URL('../../../config/marketplaces/', import.meta.url),
);

const marketplaceYamlSchema = z.object({
  id: z.string().min(1),
  reviews_url: z.string().url(),
});

export function marketplaceConfigPath(configDir: string, marketplaceId: string): string {
  return path.join(configDir, `${marketplaceId}.yaml`);
}

/**
 * v1 stub: validates ToS flag + yaml presence, then yields nothing.
 * Must not perform HTTP (including robots.txt).
 */
export class JsonApiAdapter implements MarketplaceAdapter {
  readonly id = 'json_api' as const;

  constructor(private readonly configDir = DEFAULT_MARKETPLACE_CONFIG_DIR) {}

  async *crawl(opts: CrawlOptions): AsyncIterable<NormalizedReview> {
    if (opts.iAcceptTos !== true) {
      throw new TosRequiredError();
    }
    const marketplaceId = opts.marketplaceId;
    if (marketplaceId === undefined || marketplaceId.length === 0) {
      throw new MarketplaceNotConfiguredError('');
    }
    const configPath = marketplaceConfigPath(this.configDir, marketplaceId);
    if (!existsSync(configPath)) {
      throw new MarketplaceNotConfiguredError(marketplaceId);
    }
    const parsed: unknown = parseYaml(readFileSync(configPath, 'utf8'));
    marketplaceYamlSchema.parse(parsed);
    // v1: configuration is valid; still zero HTTP and zero reviews.
    yield* [];
  }
}
