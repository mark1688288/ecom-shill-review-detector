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
export {
  compileLogisticsPattern,
  charLengthBqCompatible,
  strippedCharLength,
  V0_LOGISTICS_PHRASES,
} from './shared/layer1-regex.js';
export type { LogisticsPhrase } from './shared/layer1-regex.js';
export { classifyLayer1 } from './shared/layer1-predicates.js';
export type {
  ClassifyLayer1Input,
  Layer1Classification,
  Layer1ExclusionReason,
} from './shared/layer1-predicates.js';
export {
  burstZScore,
  isDayBurst,
  isHourBurst,
} from './analysis/burst.js';
export {
  SHILL_SCORE_THRESHOLD,
  edgesFromCollisions,
  templateCollisionPairs,
} from './analysis/collisions.js';
export {
  DISCLAIMER_EN,
  DISCLAIMER_ZH,
  renderDot,
  renderJson,
  renderMarkdown,
} from './analysis/report.js';

