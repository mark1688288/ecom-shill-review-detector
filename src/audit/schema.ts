// SPDX-License-Identifier: GPL-3.0-only
import { z } from 'zod';

export const LINGUISTIC_STYLES = [
  'canned_pr',
  'fake_oral_cantonese',
  'genuine_oral',
  'mixed_code_switch',
  'formal_written_chinese',
  'english_heavy',
  'unknown',
] as const;

export const LinguisticStyle = z.enum(LINGUISTIC_STYLES);

export const SIGNAL_CODES = [
  'STOCK_PRAISE',
  'NO_PRODUCT_SPECIFICS',
  'TEMPLATE_OPENER',
  'TEMPLATE_CLOSER',
  'FAKE_ORALITY',
  'SOCIAL_PROOF_CLICHE',
  'REPURCHASE_CLICHE',
  'BRAND_COMPARE_CLICHE',
  'CP_VALUE_CLICHE',
  'PACKAGING_PRAISE_ONLY',
  'SKIN_RESULT_VAGUE',
  'URGENCY_MARKETING',
  'GENUINE_DETAIL',
  'GENUINE_FLAW_MENTION',
] as const;

export const DetectedSignalCode = z.enum(SIGNAL_CODES);

export const UNLISTED_TEMPLATE = 'unlisted_template';

export const DetectedSignal = z.object({
  code: DetectedSignalCode,
  span: z.string().max(80),
  start_char: z.number().int().nonnegative().optional(),
  end_char: z.number().int().nonnegative().optional(),
});

export const GeminiAssessmentJson = z.object({
  shill_score: z.number().int().min(0).max(100),
  template_detected: z.boolean(),
  template_id: z.string().nullable(),
  template_name: z.string().nullable(),
  linguistic_style: LinguisticStyle,
  detected_signals: z.array(DetectedSignal).max(12),
  rationale_short: z.string().max(280),
});

export const GeminiAssessment = GeminiAssessmentJson.extend({
  shill_score: z.coerce.number().min(0).max(100).transform((n) => Math.round(n)),
});

export type GeminiAssessment = z.infer<typeof GeminiAssessment>;
export type DetectedSignal = z.infer<typeof DetectedSignal>;

/** Vertex JSON Schema from Zod (no transform). Do not hand-write a second schema. */
export const geminiResponseJsonSchema = z.toJSONSchema(GeminiAssessmentJson);

const SIGNAL_CODE_SET = new Set<string>(SIGNAL_CODES);

export type SanitizeOk = {
  ok: true;
  assessment: GeminiAssessment;
  signal_span_mismatch_count: number;
};

export type SanitizeFail = {
  ok: false;
  error_class: 'schema';
  error_message: string;
};

export type SanitizeResult = SanitizeOk | SanitizeFail;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function parseJsonInput(raw: unknown): unknown {
  if (typeof raw !== 'string') {
    return raw;
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return { __unparseable: true };
  }
}

function offsetsMatchSpan(
  commentText: string,
  span: string,
  start: number,
  end: number,
): boolean {
  if (start >= end) {
    return false;
  }
  const points = Array.from(commentText);
  if (end > points.length || start < 0) {
    return false;
  }
  return points.slice(start, end).join('') === span;
}

function sanitizeSignals(
  rawSignals: unknown,
  commentText: string,
): { signals: DetectedSignal[]; signal_span_mismatch_count: number } {
  const signal_span_mismatch_count = { n: 0 };
  if (!Array.isArray(rawSignals)) {
    return { signals: [], signal_span_mismatch_count: 0 };
  }
  const signals: DetectedSignal[] = [];
  for (const item of rawSignals) {
    const rec = asRecord(item);
    if (rec === null) {
      continue;
    }
    const code = rec['code'];
    if (typeof code !== 'string' || !SIGNAL_CODE_SET.has(code)) {
      continue;
    }
    const span = rec['span'];
    if (typeof span !== 'string' || span.length === 0 || span.length > 80) {
      continue;
    }
    if (!commentText.includes(span)) {
      signal_span_mismatch_count.n += 1;
      continue;
    }
    const startRaw = rec['start_char'];
    const endRaw = rec['end_char'];
    const hasStart = typeof startRaw === 'number' && Number.isInteger(startRaw);
    const hasEnd = typeof endRaw === 'number' && Number.isInteger(endRaw);
    const cleaned: DetectedSignal = {
      code: code as DetectedSignal['code'],
      span,
    };
    if (hasStart && hasEnd && offsetsMatchSpan(commentText, span, startRaw, endRaw)) {
      cleaned.start_char = startRaw;
      cleaned.end_char = endRaw;
    }
    signals.push(cleaned);
    if (signals.length >= 12) {
      break;
    }
  }
  return { signals, signal_span_mismatch_count: signal_span_mismatch_count.n };
}

export function sanitizeGeminiPayload(
  raw: unknown,
  commentText: string,
  allowedTemplateIds: ReadonlySet<string>,
): SanitizeResult {
  const parsed = parseJsonInput(raw);
  const rec = asRecord(parsed);
  if (rec === null || rec['__unparseable'] === true) {
    return { ok: false, error_class: 'schema', error_message: 'assessment JSON is not an object' };
  }
  const { signals, signal_span_mismatch_count } = sanitizeSignals(
    rec['detected_signals'],
    commentText,
  );
  const templateDetected = rec['template_detected'];
  let templateId = rec['template_id'] === undefined ? null : rec['template_id'];
  let templateName = rec['template_name'] === undefined ? null : rec['template_name'];
  if (templateDetected === false) {
    templateId = null;
    templateName = null;
  } else if (templateDetected === true) {
    if (typeof templateId === 'string' && templateId.length > 0) {
      if (!allowedTemplateIds.has(templateId) && templateId !== UNLISTED_TEMPLATE) {
        templateId = UNLISTED_TEMPLATE;
      }
    } else {
      templateId = null;
    }
    if (templateName !== null && typeof templateName !== 'string') {
      templateName = null;
    }
  }

  let rationale = rec['rationale_short'];
  if (typeof rationale === 'string' && rationale.length > 280) {
    rationale = rationale.slice(0, 280);
  }

  const candidate = {
    shill_score: rec['shill_score'],
    template_detected: templateDetected,
    template_id: templateId,
    template_name: templateName,
    linguistic_style: rec['linguistic_style'],
    detected_signals: signals,
    rationale_short: rationale,
  };
  const result = GeminiAssessment.safeParse(candidate);
  if (!result.success) {
    return {
      ok: false,
      error_class: 'schema',
      error_message: result.error.issues.map((issue) => issue.message).join('; '),
    };
  }
  return { ok: true, assessment: result.data, signal_span_mismatch_count };
}
