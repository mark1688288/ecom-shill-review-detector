// SPDX-License-Identifier: GPL-3.0-only

export type LogisticsPhrase = {
  phrase_id: string;
  phrase: string;
  match_type: string;
  lang: string;
  category: string;
  is_active: boolean;
  phrase_version: string;
};

/** v0 list is hypothesis, replaceable, not complete. Kept in sync with sql/seeds. */
export const V0_LOGISTICS_PHRASES: LogisticsPhrase[] = [
  { phrase_id: 'log_01', phrase: '送貨快', match_type: 'contains', lang: 'yue', category: 'shipping_speed', is_active: true, phrase_version: 'v0' },
  { phrase_id: 'log_02', phrase: '送貨好快', match_type: 'contains', lang: 'yue', category: 'shipping_speed', is_active: true, phrase_version: 'v0' },
  { phrase_id: 'log_03', phrase: '到貨快', match_type: 'contains', lang: 'yue', category: 'shipping_speed', is_active: true, phrase_version: 'v0' },
  { phrase_id: 'log_04', phrase: '好快收到', match_type: 'contains', lang: 'yue', category: 'shipping_speed', is_active: true, phrase_version: 'v0' },
  { phrase_id: 'log_05', phrase: '很快就收到', match_type: 'contains', lang: 'yue', category: 'shipping_speed', is_active: true, phrase_version: 'v0' },
  { phrase_id: 'log_06', phrase: '第二日就到', match_type: 'contains', lang: 'yue', category: 'shipping_speed', is_active: true, phrase_version: 'v0' },
  { phrase_id: 'log_07', phrase: '第二日送到', match_type: 'contains', lang: 'yue', category: 'shipping_speed', is_active: true, phrase_version: 'v0' },
  { phrase_id: 'log_08', phrase: '包裝完好', match_type: 'contains', lang: 'yue', category: 'packaging', is_active: true, phrase_version: 'v0' },
  { phrase_id: 'log_09', phrase: '包裝完好無損', match_type: 'contains', lang: 'yue', category: 'packaging', is_active: true, phrase_version: 'v0' },
  { phrase_id: 'log_10', phrase: '包裝好好', match_type: 'contains', lang: 'yue', category: 'packaging', is_active: true, phrase_version: 'v0' },
  { phrase_id: 'log_11', phrase: '包裝完整', match_type: 'contains', lang: 'yue', category: 'packaging', is_active: true, phrase_version: 'v0' },
  { phrase_id: 'log_12', phrase: '順豐好快', match_type: 'contains', lang: 'yue', category: 'courier', is_active: true, phrase_version: 'v0' },
  { phrase_id: 'log_13', phrase: '順豐', match_type: 'contains', lang: 'yue', category: 'courier', is_active: true, phrase_version: 'v0' },
  { phrase_id: 'log_14', phrase: '快遞好快', match_type: 'contains', lang: 'yue', category: 'shipping_speed', is_active: true, phrase_version: 'v0' },
  { phrase_id: 'log_15', phrase: '物流快', match_type: 'contains', lang: 'yue', category: 'shipping_speed', is_active: true, phrase_version: 'v0' },
  { phrase_id: 'log_16', phrase: '物流好快', match_type: 'contains', lang: 'yue', category: 'shipping_speed', is_active: true, phrase_version: 'v0' },
  { phrase_id: 'log_17', phrase: '運費', match_type: 'contains', lang: 'yue', category: 'shipping_speed', is_active: true, phrase_version: 'v0' },
  { phrase_id: 'log_18', phrase: '未拆已經好滿意', match_type: 'contains', lang: 'yue', category: 'generic_thanks', is_active: true, phrase_version: 'v0' },
  { phrase_id: 'log_19', phrase: '正品', match_type: 'contains', lang: 'yue', category: 'generic_thanks', is_active: true, phrase_version: 'v0' },
  { phrase_id: 'log_20', phrase: '好快就送到', match_type: 'contains', lang: 'yue', category: 'shipping_speed', is_active: true, phrase_version: 'v0' },
  { phrase_id: 'log_21', phrase: 'fast delivery', match_type: 'contains', lang: 'en', category: 'shipping_speed', is_active: true, phrase_version: 'v0' },
  { phrase_id: 'log_22', phrase: 'well packed', match_type: 'contains', lang: 'en', category: 'packaging', is_active: true, phrase_version: 'v0' },
  { phrase_id: 'log_23', phrase: '多謝賣家', match_type: 'contains', lang: 'yue', category: 'generic_thanks', is_active: true, phrase_version: 'v0' },
  { phrase_id: 'log_24', phrase: '賣家態度好', match_type: 'contains', lang: 'yue', category: 'generic_thanks', is_active: true, phrase_version: 'v0' },
  { phrase_id: 'log_25', phrase: '回覆得快', match_type: 'contains', lang: 'yue', category: 'generic_thanks', is_active: true, phrase_version: 'v0' },
];

/** Aligns with sql/layer1/filter_stage1.sql ARRAY_AGG ORDER BY LENGTH DESC. */
/** Returns pattern source (not a global RegExp). Empty list → null (strip is identity; never `new RegExp('', 'gi')`). */
export function compileLogisticsPattern(
  phrases: { phrase: string; match_type: string }[],
): string | null {
  const parts = phrases
    .filter((p) => p.match_type === 'contains' || p.match_type === 'exact')
    .map((p) => p.phrase)
    .sort((a, b) => b.length - a.length || a.localeCompare(b))
    .map((p) => p.replace(/[\\.^$|?*+()[\]{}]/g, '\\$&'));
  if (parts.length === 0) return null;
  return parts.join('|');
}

export function charLengthBqCompatible(s: string): number {
  return Array.from(s).length;
}

export function strippedCharLength(comment: string, patternSource: string | null): number {
  if (patternSource === null) return charLengthBqCompatible(comment.trim());
  const pattern = new RegExp(patternSource, 'gi');
  return charLengthBqCompatible(comment.replace(pattern, '').trim());
}
