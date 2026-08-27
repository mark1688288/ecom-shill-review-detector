// SPDX-License-Identifier: GPL-3.0-only
import type { LanguageHint } from '../shared/types.js';

export type MarketplaceId = 'fixture' | 'json_api';

export interface CrawlOptions {
  storeIds?: string[];
  productIds?: string[];
  since?: Date;
  until?: Date;
  maxReviews?: number;
  /** fixture 用 */
  inputPath?: string;
  dryRun?: boolean;
  /**
   * json_api 必填（即便 v1 零 HTTP）。沒有此旗標必須非 0 exit。
   * 表示操作者已自行評估目標站 ToS / robots / 當地法律。
   * 即使有旗標也不得發出 HTTP。
   */
  iAcceptTos?: boolean;
  /** json_api：config/marketplaces/<id>.yaml */
  marketplaceId?: string;
}

export interface NormalizedReview {
  marketplace: string;
  native_review_id: string | null;
  store_id: string;
  product_id: string;
  /** 已 HMAC 遮蔽，adapter 不得傳入明文 */
  reviewer_id_hash: string;
  star_rating: number;
  comment_text: string;
  review_ts: Date;
  source_url_canonical: string | null;
  language_hint: LanguageHint;
  has_media: boolean;
  raw_payload_hash: string;
}

export interface MarketplaceAdapter {
  readonly id: MarketplaceId;
  crawl(opts: CrawlOptions): AsyncIterable<NormalizedReview>;
}

export type CrawlStats = {
  n_read: number;
  n_accepted: number;
  n_rejected: number;
  n_rejected_json: number;
  n_rejected_zod: number;
  n_rejected_star: number;
  n_filtered: number;
};

export function emptyCrawlStats(): CrawlStats {
  return {
    n_read: 0,
    n_accepted: 0,
    n_rejected: 0,
    n_rejected_json: 0,
    n_rejected_zod: 0,
    n_rejected_star: 0,
    n_filtered: 0,
  };
}

export class TosRequiredError extends Error {
  readonly exitCode = 1;

  constructor() {
    super(
      'json_api requires --i-accept-tos (operator must evaluate target ToS / robots / local law). v1 still sends no HTTP.',
    );
    this.name = 'TosRequiredError';
  }
}

export class MarketplaceNotConfiguredError extends Error {
  readonly exitCode = 1;
  readonly marketplaceId: string;

  constructor(marketplaceId: string) {
    super(
      `Marketplace '${marketplaceId}' is not configured. Add config/marketplaces/${marketplaceId}.yaml (v1 still sends no HTTP).`,
    );
    this.name = 'MarketplaceNotConfiguredError';
    this.marketplaceId = marketplaceId;
  }
}
