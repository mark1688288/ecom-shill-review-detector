// SPDX-License-Identifier: GPL-3.0-only
export type { LanguageHint, PipelinePhase } from './shared/types.js';
export { LANGUAGE_HINTS, PIPELINE_PHASES } from './shared/types.js';
export {
  assertSalt,
  loadEnv,
  loadDefaultConfig,
  commandRequiresGcp,
} from './shared/env.js';
export type { AppConfig, CommandName, LoadedEnv } from './shared/env.js';
export { getLogger, createLogger } from './shared/logger.js';
export {
  resolvePipelineRunId,
  writeLatestRun,
  readLatestRun,
  printPipelineRunId,
} from './shared/run-id.js';
export {
  sha256Hex,
  hmacSha256Hex,
  stripTrackingQueryParams,
  REVIEW_ID_VERSION,
} from './shared/ids.js';
export {
  hashReviewerId,
  contentHash,
  sourceUrlHash,
  makeReviewId,
} from './crawler/hash.js';
export type { MakeReviewIdInput } from './crawler/hash.js';
export type { NormalizedReview, MarketplaceId } from './crawler/adapter.js';
export { FixtureReviewRaw } from './crawler/types.js';
