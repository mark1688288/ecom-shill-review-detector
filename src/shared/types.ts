// SPDX-License-Identifier: GPL-3.0-only

export const LANGUAGE_HINTS = [
  'yue',
  'zh-Hant',
  'zh-Hans',
  'en',
  'mixed',
  'unknown',
] as const;

export type LanguageHint = (typeof LANGUAGE_HINTS)[number];

export const PIPELINE_PHASES = [
  'crawl',
  'load',
  'layer1',
  'layer2',
  'audit',
  'analyze',
] as const;

export type PipelinePhase = (typeof PIPELINE_PHASES)[number];
