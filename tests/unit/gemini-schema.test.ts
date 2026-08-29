// SPDX-License-Identifier: GPL-3.0-only
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { thinkingConfigForModel } from '../../src/audit/gemini-client.js';
import { ALLOWED_TEMPLATE_IDS, buildUserPrompt, SYSTEM_PROMPT } from '../../src/audit/prompt.js';
import {
  GeminiAssessment,
  GeminiAssessmentJson,
  SIGNAL_CODES,
  UNLISTED_TEMPLATE,
  geminiResponseJsonSchema,
  sanitizeGeminiPayload,
} from '../../src/audit/schema.js';
import {
  buildCopyForwardSql,
  buildMergeAssessmentSql,
  buildSelectPendingSql,
} from '../../src/audit/checkpoint.js';
import type { BqConfig } from '../../src/shared/bq.js';

const ROOT = process.cwd();
const COMMENT =
  '今次係我親身試用過先敢講，真係同廣告講嘅一樣，用落好舒服，效果好明顯。';
const COERCED_COMMENT = '用咗兩個禮拜皮膚真係變好咗，暗瘡少咗。';

const CONFIG: BqConfig = {
  project: 'demo-project',
  location: 'asia-east1',
  dataset: 'ecom_shill',
};

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(path.join(ROOT, 'fixtures/expected', name), 'utf8')) as unknown;
}

function collectStringEnums(node: unknown, acc: string[][] = []): string[][] {
  if (typeof node !== 'object' || node === null) {
    return acc;
  }
  if (Array.isArray(node)) {
    for (const item of node) {
      collectStringEnums(item, acc);
    }
    return acc;
  }
  const rec = node as Record<string, unknown>;
  if (Array.isArray(rec['enum']) && rec['enum'].every((item) => typeof item === 'string')) {
    acc.push(rec['enum'] as string[]);
  }
  for (const value of Object.values(rec)) {
    collectStringEnums(value, acc);
  }
  return acc;
}

describe('GeminiAssessment parse', () => {
  it('accepts 0 and 100', () => {
    const base = {
      template_detected: false,
      template_id: null,
      template_name: null,
      linguistic_style: 'genuine_oral',
      detected_signals: [],
      rationale_short: 'ok',
    };
    expect(GeminiAssessment.parse({ ...base, shill_score: 0 }).shill_score).toBe(0);
    expect(GeminiAssessment.parse({ ...base, shill_score: 100 }).shill_score).toBe(100);
  });

  it('coerces a fractional score with round (JSON 87.0 is indistinguishable from 87)', () => {
    expect(
      GeminiAssessment.parse({
        shill_score: 87.4,
        template_detected: false,
        template_id: null,
        template_name: null,
        linguistic_style: 'genuine_oral',
        detected_signals: [],
        rationale_short: 'coerced',
      }).shill_score,
    ).toBe(87);
    expect(GeminiAssessmentJson.safeParse({
      shill_score: 87.4,
      template_detected: false,
      template_id: null,
      template_name: null,
      linguistic_style: 'genuine_oral',
      detected_signals: [],
      rationale_short: 'int only',
    }).success).toBe(false);
  });
});

describe('sanitizeGeminiPayload', () => {
  it('accepts the valid golden fixture', () => {
    const raw = loadFixture('gemini-payload-valid.json');
    const result = sanitizeGeminiPayload(raw, COMMENT, ALLOWED_TEMPLATE_IDS);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.assessment.shill_score).toBe(82);
    expect(result.assessment.template_id).toBe('seed_personal_trial');
    expect(result.assessment.detected_signals).toHaveLength(1);
    expect(result.assessment.detected_signals[0]?.start_char).toBe(4);
    expect(result.signal_span_mismatch_count).toBe(0);
  });

  it('coerces 87.0, strips unknown code and bad span, drops bad offsets, clears template ids, not DLQ', () => {
    const raw = loadFixture('gemini-payload-coerced.json');
    const result = sanitizeGeminiPayload(raw, COERCED_COMMENT, ALLOWED_TEMPLATE_IDS);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.assessment.shill_score).toBe(87);
    expect(result.assessment.template_detected).toBe(false);
    expect(result.assessment.template_id).toBeNull();
    expect(result.assessment.template_name).toBeNull();
    expect(result.assessment.detected_signals).toHaveLength(1);
    expect(result.assessment.detected_signals[0]?.code).toBe('GENUINE_DETAIL');
    expect(result.assessment.detected_signals[0]?.span).toBe('用咗兩個禮拜');
    expect(result.assessment.detected_signals[0]?.start_char).toBeUndefined();
    expect(result.signal_span_mismatch_count).toBe(1);
  });

  it('rewrites unknown template_id to unlisted_template', () => {
    const result = sanitizeGeminiPayload(
      {
        shill_score: 80,
        template_detected: true,
        template_id: 'agency_secret',
        template_name: 'secret',
        linguistic_style: 'canned_pr',
        detected_signals: [],
        rationale_short: 'unknown template',
      },
      COMMENT,
      ALLOWED_TEMPLATE_IDS,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.assessment.template_id).toBe(UNLISTED_TEMPLATE);
  });

  it('sends unparseable JSON to schema DLQ', () => {
    const result = sanitizeGeminiPayload('{', COMMENT, ALLOWED_TEMPLATE_IDS);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error_class).toBe('schema');
  });
});

describe('geminiResponseJsonSchema', () => {
  it('is generated from Zod and includes DetectedSignal.code enum', () => {
    const enums = collectStringEnums(geminiResponseJsonSchema);
    const signalEnum = enums.find((values) => values.includes('STOCK_PRAISE'));
    expect(signalEnum).toEqual([...SIGNAL_CODES]);
    expect(JSON.stringify(geminiResponseJsonSchema)).not.toMatch(/responseSchema/);
  });
});

describe('thinkingConfigForModel', () => {
  it('uses thinkingBudget 0 for 2.5 and thinkingLevel for 3.x', () => {
    const two = thinkingConfigForModel('gemini-2.5-flash', {
      thinkingBudget: 0,
      thinkingLevel: 'MINIMAL',
    });
    expect(two).toEqual({ thinkingBudget: 0 });
    expect(two).not.toHaveProperty('thinkingLevel');

    const three = thinkingConfigForModel('gemini-3.5-flash', {
      thinkingBudget: 0,
      thinkingLevel: 'MINIMAL',
    });
    expect(three).toEqual({ thinkingLevel: 'MINIMAL' });
    expect(three).not.toHaveProperty('thinkingBudget');
  });
});

describe('prompt', () => {
  it('does not mention reviewer_id_hash', () => {
    const src = readFileSync(path.join(ROOT, 'src/audit/prompt.ts'), 'utf8');
    expect(src).not.toMatch(/reviewer_id_hash/);
    expect(SYSTEM_PROMPT).not.toMatch(/reviewer_id_hash/);
    expect(
      buildUserPrompt({
        commentText: COMMENT,
        matchedSeedId: 'seed_personal_trial',
        matchedSeedCategory: 'personal_trial',
      }),
    ).not.toMatch(/reviewer_id_hash/);
  });
});

describe('checkpoint SQL', () => {
  it('copy-forward and assessment MERGE use named columns, never INSERT ROW', () => {
    const copy = buildCopyForwardSql(CONFIG);
    const merge = buildMergeAssessmentSql(CONFIG);
    const pending = buildSelectPendingSql(CONFIG, false);
    const force = buildSelectPendingSql(CONFIG, true);
    for (const sql of [copy, merge]) {
      expect(sql).toMatch(/WHEN NOT MATCHED THEN INSERT \(/);
      expect(sql).not.toMatch(/INSERT ROW/i);
    }
    expect(copy).toContain("prev.model_id = @gemini_model");
    expect(copy).toContain("prev.prompt_version = @prompt_version");
    expect(copy.indexOf('WHERE s.pipeline_run_id')).toBeGreaterThan(copy.indexOf('JOIN'));
    expect(copy.indexOf('QUALIFY')).toBeGreaterThan(copy.indexOf('WHERE s.pipeline_run_id'));
    expect(pending).toContain('a.review_id IS NULL');
    expect(force).not.toContain('a.review_id IS NULL');
    expect(merge).toContain('WHEN MATCHED THEN UPDATE SET');
  });
});

describe('bq-apply.sh audit DDL', () => {
  it('applies assessments and DLQ after stage2', () => {
    const script = readFileSync(path.join(ROOT, 'scripts/bq-apply.sh'), 'utf8');
    expect(script).toContain('10_gemini_review_assessments.sql');
    expect(script).toContain('11_gemini_assessment_errors.sql');
    expect(script.indexOf('09_stage2_suspicious.sql')).toBeLessThan(
      script.indexOf('10_gemini_review_assessments.sql'),
    );
  });
});
