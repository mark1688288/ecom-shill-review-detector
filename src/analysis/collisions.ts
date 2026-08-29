// SPDX-License-Identifier: GPL-3.0-only

export const SHILL_SCORE_THRESHOLD = 75;
export const UNLISTED_TEMPLATE_ID = 'unlisted_template';

export type AssessmentLike = {
  pipeline_run_id: string;
  store_id: string;
  review_id: string;
  template_detected: boolean;
  template_id: string | null;
  shill_score: number;
};

export type TemplateCollisionPair = {
  pipeline_run_id: string;
  store_id_a: string;
  store_id_b: string;
  review_id_a: string;
  review_id_b: string;
  template_id: string;
  shill_score_a: number;
  shill_score_b: number;
  pair_type: 'template';
};

export type NetworkEdge = {
  pipeline_run_id: string;
  src_store_id: string;
  dst_store_id: string;
  weight: number;
  template_ids: string[];
};

function isEligible(row: AssessmentLike): row is AssessmentLike & { template_id: string } {
  return (
    row.template_detected &&
    row.template_id !== null &&
    row.template_id !== UNLISTED_TEMPLATE_ID &&
    row.shill_score >= SHILL_SCORE_THRESHOLD
  );
}

export function templateCollisionPairs(rows: readonly AssessmentLike[]): TemplateCollisionPair[] {
  const eligible = rows.filter(isEligible);
  const pairs: TemplateCollisionPair[] = [];
  for (let i = 0; i < eligible.length; i += 1) {
    const left = eligible[i];
    if (left === undefined) {
      continue;
    }
    for (let j = i + 1; j < eligible.length; j += 1) {
      const right = eligible[j];
      if (right === undefined) {
        continue;
      }
      if (left.pipeline_run_id !== right.pipeline_run_id) {
        continue;
      }
      if (left.template_id !== right.template_id) {
        continue;
      }
      if (left.store_id === right.store_id) {
        continue;
      }
      const [a, b] = left.store_id < right.store_id ? [left, right] : [right, left];
      pairs.push({
        pipeline_run_id: a.pipeline_run_id,
        store_id_a: a.store_id,
        store_id_b: b.store_id,
        review_id_a: a.review_id,
        review_id_b: b.review_id,
        template_id: a.template_id,
        shill_score_a: a.shill_score,
        shill_score_b: b.shill_score,
        pair_type: 'template',
      });
    }
  }
  return pairs;
}

export function edgesFromCollisions(
  pairs: readonly Pick<
    TemplateCollisionPair,
    'pipeline_run_id' | 'store_id_a' | 'store_id_b' | 'template_id'
  >[],
): NetworkEdge[] {
  const grouped = new Map<
    string,
    { pipeline_run_id: string; src: string; dst: string; weight: number; templates: Set<string> }
  >();
  for (const pair of pairs) {
    const key = `${pair.pipeline_run_id}\0${pair.store_id_a}\0${pair.store_id_b}`;
    let edge = grouped.get(key);
    if (edge === undefined) {
      edge = {
        pipeline_run_id: pair.pipeline_run_id,
        src: pair.store_id_a,
        dst: pair.store_id_b,
        weight: 0,
        templates: new Set<string>(),
      };
      grouped.set(key, edge);
    }
    edge.weight += 1;
    if (pair.template_id.length > 0) {
      edge.templates.add(pair.template_id);
    }
  }
  return [...grouped.values()].map((edge) => ({
    pipeline_run_id: edge.pipeline_run_id,
    src_store_id: edge.src,
    dst_store_id: edge.dst,
    weight: edge.weight,
    template_ids: [...edge.templates].sort(),
  }));
}
