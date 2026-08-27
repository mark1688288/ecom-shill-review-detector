// SPDX-License-Identifier: GPL-3.0-only
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  charLengthBqCompatible,
  compileLogisticsPattern,
  strippedCharLength,
  V0_LOGISTICS_PHRASES,
} from '../../src/shared/layer1-regex.js';

const PATTERN = compileLogisticsPattern(V0_LOGISTICS_PHRASES);

describe('compileLogisticsPattern', () => {
  it('orders longest phrases first so 包裝完好無損 strips as a whole', () => {
    expect(PATTERN).not.toBeNull();
    const parts = PATTERN?.split('|') ?? [];
    expect(parts.indexOf('包裝完好無損')).toBeGreaterThan(-1);
    expect(parts.indexOf('包裝完好')).toBeGreaterThan(-1);
    expect(parts.indexOf('包裝完好無損')).toBeLessThan(parts.indexOf('包裝完好'));
    expect(strippedCharLength('包裝完好無損', PATTERN)).toBe(0);
    expect(strippedCharLength('包裝完好無損', PATTERN)).not.toBe(
      charLengthBqCompatible('無損'),
    );
  });

  it('uses the same patternSource on two comments without lastIndex leaks', () => {
    expect(strippedCharLength('包裝完好無損', PATTERN)).toBe(0);
    expect(strippedCharLength('送貨好快', PATTERN)).toBe(0);
    expect(strippedCharLength('包裝完好', PATTERN)).toBe(0);
  });

  it('returns null for an empty list and treats strip as identity', () => {
    expect(compileLogisticsPattern([])).toBeNull();
    expect(strippedCharLength('  abc  ', null)).toBe(3);
    expect(strippedCharLength('包裝完好', null)).toBe(charLengthBqCompatible('包裝完好'));
  });

  it('ignores regexp match_type rows', () => {
    const withRegexp = compileLogisticsPattern([
      { phrase: '包裝完好無損', match_type: 'regexp' },
      { phrase: '送貨好快', match_type: 'contains' },
    ]);
    expect(withRegexp).toBe('送貨好快');
    expect(compileLogisticsPattern([{ phrase: 'foo+', match_type: 'regexp' }])).toBeNull();
  });

  it('compiles exact into the same unanchored alternation as contains', () => {
    const src = compileLogisticsPattern([
      { phrase: 'Foo', match_type: 'exact' },
      { phrase: 'bar', match_type: 'contains' },
    ]);
    expect(src?.split('|').sort()).toEqual(['Foo', 'bar']);
    expect(strippedCharLength('xxFooyy', src)).toBe(4);
  });

  it('never compiles an empty pattern source', () => {
    expect(compileLogisticsPattern([])).toBeNull();
    expect(compileLogisticsPattern([{ phrase: 'x', match_type: 'regexp' }])).toBeNull();
    expect(PATTERN).not.toBe('');
    const src = readFileSync(path.join(process.cwd(), 'src/shared/layer1-regex.ts'), 'utf8');
    const fn = src.slice(src.indexOf('export function strippedCharLength'));
    expect(fn).toContain('if (patternSource === null)');
    expect(fn).toContain("new RegExp(patternSource, 'gi')");
    expect(fn).not.toMatch(/new RegExp\(\s*['"]['"]\s*,/);
  });

  it('keeps V0 phrase strings aligned with the SQL seed file', () => {
    const seed = readFileSync(
      path.join(process.cwd(), 'sql/seeds/logistics_canned_phrases.sql'),
      'utf8',
    );
    expect(seed).toMatch(/hypothesis, replaceable, not complete/);
    expect(V0_LOGISTICS_PHRASES).toHaveLength(25);
    for (const phrase of V0_LOGISTICS_PHRASES) {
      expect(seed).toContain(phrase.phrase_id);
      expect(seed).toContain(phrase.phrase);
      expect(phrase.is_active).toBe(true);
      expect(phrase.phrase_version).toBe('v0');
    }
  });
});
