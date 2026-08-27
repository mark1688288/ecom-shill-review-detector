// SPDX-License-Identifier: GPL-3.0-only
import { charLengthBqCompatible, strippedCharLength } from './layer1-regex.js';

export const LAYER1_EXCLUSION_REASONS = [
  'non_five_star',
  'too_short',
  'pure_logistics',
  'pass',
] as const;

export type Layer1ExclusionReason = (typeof LAYER1_EXCLUSION_REASONS)[number];

export type Layer1Classification = {
  char_length: number;
  stripped_char_length: number;
  exclusion_reason: Layer1ExclusionReason;
  passes: boolean;
};

export type ClassifyLayer1Input = {
  star_rating: number;
  comment_text: string;
  patternSource: string | null;
};

export function classifyLayer1(input: ClassifyLayer1Input): Layer1Classification {
  const char_length = charLengthBqCompatible(input.comment_text);
  const stripped_char_length = strippedCharLength(input.comment_text, input.patternSource);
  let exclusion_reason: Layer1ExclusionReason;
  if (input.star_rating !== 5) {
    exclusion_reason = 'non_five_star';
  } else if (char_length < 25) {
    exclusion_reason = 'too_short';
  } else if (stripped_char_length < 25) {
    exclusion_reason = 'pure_logistics';
  } else {
    exclusion_reason = 'pass';
  }
  return {
    char_length,
    stripped_char_length,
    exclusion_reason,
    passes: exclusion_reason === 'pass',
  };
}
