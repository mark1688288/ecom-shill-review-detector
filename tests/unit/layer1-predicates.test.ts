// SPDX-License-Identifier: GPL-3.0-only
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { normalizeCommentText } from '../../src/crawler/hash.js';
import { parseFixtureReviewLine, type FixtureReviewRaw } from '../../src/crawler/types.js';
import { classifyLayer1 } from '../../src/shared/layer1-predicates.js';
import { compileLogisticsPattern, V0_LOGISTICS_PHRASES } from '../../src/shared/layer1-regex.js';

type GoldenFile = {
  golden_files: string[];
  pass_native_review_ids: string[];
  must_exclude_native_review_ids: string[];
};

const PATTERN = compileLogisticsPattern(V0_LOGISTICS_PHRASES);
const GOLDEN: GoldenFile = JSON.parse(
  readFileSync(path.join(process.cwd(), 'fixtures/expected/stage1_review_ids.json'), 'utf8'),
) as GoldenFile;

function loadFixture(name: string): FixtureReviewRaw[] {
  const text = readFileSync(path.join(process.cwd(), 'fixtures/reviews', name), 'utf8');
  const rows: FixtureReviewRaw[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    const parsed = parseFixtureReviewLine(trimmed);
    if (!parsed.success) {
      throw new Error(`invalid fixture row in ${name}: ${trimmed}`);
    }
    rows.push(parsed.data);
  }
  return rows;
}

function classifyFixture(row: FixtureReviewRaw) {
  return classifyLayer1({
    star_rating: row.star_rating,
    comment_text: normalizeCommentText(row.comment_text),
    patternSource: PATTERN,
  });
}

describe('classifyLayer1 priority', () => {
  it('applies non_five_star before too_short and pure_logistics', () => {
    const fourStar = classifyLayer1({
      star_rating: 4,
      comment_text: '送貨好快'.repeat(8),
      patternSource: PATTERN,
    });
    expect(fourStar.exclusion_reason).toBe('non_five_star');
    expect(fourStar.passes).toBe(false);

    const short = classifyLayer1({
      star_rating: 5,
      comment_text: '好用',
      patternSource: PATTERN,
    });
    expect(short.exclusion_reason).toBe('too_short');

    const logistics = classifyLayer1({
      star_rating: 5,
      comment_text: '送貨好快'.repeat(8),
      patternSource: PATTERN,
    });
    expect(logistics.char_length).toBeGreaterThanOrEqual(25);
    expect(logistics.stripped_char_length).toBeLessThan(25);
    expect(logistics.exclusion_reason).toBe('pure_logistics');
    expect(logistics.passes).toBe(false);
  });
});

describe('stage1 golden fixtures', () => {
  it('does not include the load rewrite fixture', () => {
    expect(GOLDEN.golden_files).not.toContain('same-native-id-edit.jsonl');
  });

  it('matches fixtures/expected/stage1_review_ids.json 100%', () => {
    const pass = new Set<string>();
    const exclude = new Set<string>();
    for (const file of GOLDEN.golden_files) {
      for (const row of loadFixture(file)) {
        const result = classifyFixture(row);
        if (row.native_review_id === null) {
          expect(result.passes).toBe(false);
          expect(result.char_length).toBeLessThan(25);
          continue;
        }
        if (result.passes) {
          pass.add(row.native_review_id);
        } else {
          exclude.add(row.native_review_id);
        }
      }
    }
    expect([...pass].sort()).toEqual([...GOLDEN.pass_native_review_ids].sort());
    for (const id of GOLDEN.must_exclude_native_review_ids) {
      expect(pass.has(id)).toBe(false);
      expect(exclude.has(id)).toBe(true);
    }
  });

  it('excludes short five-star, non-five-star, and logistics-only fixtures', () => {
    for (const file of ['short-five-star.jsonl', 'non-five-star.jsonl', 'logistics-only.jsonl']) {
      for (const row of loadFixture(file)) {
        expect(classifyFixture(row).passes).toBe(false);
      }
    }
    expect(classifyFixture(loadFixture('cantonese-mix.jsonl').find((r) => r.native_review_id === 'n003')!).passes).toBe(
      false,
    );
    expect(classifyFixture(loadFixture('cantonese-mix.jsonl').find((r) => r.native_review_id === 'n002')!).passes).toBe(
      false,
    );
    expect(classifyFixture(loadFixture('cantonese-mix.jsonl').find((r) => r.native_review_id === 'n004')!).passes).toBe(
      false,
    );
  });

  it('passes genuine-long, shill-like-v0, and overlap n_ov_03 / n_ov_04', () => {
    for (const row of loadFixture('genuine-long.jsonl')) {
      expect(classifyFixture(row).passes).toBe(true);
    }
    const shill = loadFixture('shill-like-v0.jsonl');
    expect(shill).toHaveLength(7);
    for (const row of shill) {
      expect(classifyFixture(row).passes).toBe(true);
    }
    const overlap = loadFixture('overlap-logistics.jsonl');
    const byId = new Map(overlap.map((row) => [row.native_review_id, row]));
    expect(classifyFixture(byId.get('n_ov_03')!).passes).toBe(true);
    expect(classifyFixture(byId.get('n_ov_04')!).passes).toBe(true);
    expect(classifyFixture(byId.get('n_ov_01')!).passes).toBe(false);
    expect(classifyFixture(byId.get('n_ov_02')!).passes).toBe(false);
  });

  it('verifies mix n006 by CHAR_LENGTH and locks mix pass ids', () => {
    const mix = loadFixture('cantonese-mix.jsonl');
    const byId = new Map(mix.filter((row) => row.native_review_id !== null).map((row) => [row.native_review_id, row]));
    const n001 = classifyFixture(byId.get('n001')!);
    const n005 = classifyFixture(byId.get('n005')!);
    const n006 = classifyFixture(byId.get('n006')!);
    const n007 = classifyFixture(byId.get('n007')!);
    expect(n001.passes).toBe(true);
    expect(n005.passes).toBe(true);
    expect(n006.char_length).toBe(65);
    expect(n006.char_length).toBeGreaterThanOrEqual(25);
    expect(n006.passes).toBe(true);
    expect(n007.char_length).toBe(19);
    expect(n007.passes).toBe(false);
    expect(n007.exclusion_reason).toBe('too_short');
  });
});
