// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
  SHILL_SCORE_THRESHOLD,
  edgesFromCollisions,
  templateCollisionPairs,
  type AssessmentLike,
} from '../../src/analysis/collisions.js';

const RUN = '22222222-2222-4222-8222-222222222222';

function row(partial: Partial<AssessmentLike> & Pick<AssessmentLike, 'store_id' | 'review_id'>): AssessmentLike {
  return {
    pipeline_run_id: RUN,
    template_detected: true,
    template_id: 'seed_personal_trial',
    shill_score: 80,
    ...partial,
  };
}

describe('templateCollisionPairs', () => {
  it('yields exactly one pair for two stores sharing a template at score 80', () => {
    const pairs = templateCollisionPairs([
      row({ store_id: 'store-b', review_id: 'rev-b' }),
      row({ store_id: 'store-a', review_id: 'rev-a' }),
    ]);
    expect(pairs).toHaveLength(1);
    const pair = pairs[0];
    expect(pair?.store_id_a).toBe('store-a');
    expect(pair?.store_id_b).toBe('store-b');
    expect(pair?.template_id).toBe('seed_personal_trial');
    expect(pair?.shill_score_a).toBe(80);
    expect(pair?.shill_score_b).toBe(80);
    expect(edgesFromCollisions(pairs)).toEqual([
      {
        pipeline_run_id: RUN,
        src_store_id: 'store-a',
        dst_store_id: 'store-b',
        weight: 1,
        template_ids: ['seed_personal_trial'],
      },
    ]);
  });

  it('does not pair two reviews from the same store', () => {
    expect(
      templateCollisionPairs([
        row({ store_id: 'store-a', review_id: 'rev-1' }),
        row({ store_id: 'store-a', review_id: 'rev-2' }),
      ]),
    ).toEqual([]);
  });

  it('excludes unlisted_template', () => {
    expect(
      templateCollisionPairs([
        row({ store_id: 'store-a', review_id: 'rev-a', template_id: 'unlisted_template' }),
        row({ store_id: 'store-b', review_id: 'rev-b', template_id: 'unlisted_template' }),
      ]),
    ).toEqual([]);
  });

  it('excludes scores below the analysis cut', () => {
    expect(SHILL_SCORE_THRESHOLD).toBe(75);
    expect(
      templateCollisionPairs([
        row({ store_id: 'store-a', review_id: 'rev-a', shill_score: 74 }),
        row({ store_id: 'store-b', review_id: 'rev-b', shill_score: 80 }),
      ]),
    ).toEqual([]);
  });

  it('does not pair across pipeline_run_id', () => {
    expect(
      templateCollisionPairs([
        row({ store_id: 'store-a', review_id: 'rev-a' }),
        row({
          store_id: 'store-b',
          review_id: 'rev-b',
          pipeline_run_id: '33333333-3333-4333-8333-333333333333',
        }),
      ]),
    ).toEqual([]);
  });
});
