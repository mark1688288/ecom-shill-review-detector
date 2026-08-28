// SPDX-License-Identifier: GPL-3.0-only

export const PROMPT_VERSION = 'v1';

export const SEED_CATEGORY_BLURBS = [
  { seed_id: 'seed_personal_trial', category: 'personal_trial', blurb: '親身試用、同廣告一樣' },
  { seed_id: 'seed_skin_result', category: 'skin_result', blurb: '用咗幾日皮膚變好、暗瘡／toning' },
  { seed_id: 'seed_repurchase', category: 'repurchase', blurb: '回購、介紹俾屋企人' },
  { seed_id: 'seed_social_proof', category: 'social_proof', blurb: '朋友／同事極力推薦' },
  { seed_id: 'seed_cp_value', category: 'value_for_money', blurb: 'CP 值／性價比／好抵' },
  { seed_id: 'seed_brand_compare', category: 'brand_comparison', blurb: '對比舊品牌明顯好好多' },
  { seed_id: 'seed_packaging', category: 'packaging_care', blurb: '包裝好用心、有質感' },
] as const;

export const ALLOWED_TEMPLATE_IDS: ReadonlySet<string> = new Set([
  ...SEED_CATEGORY_BLURBS.map((row) => row.seed_id),
  'unlisted_template',
]);

const SEED_BLOCK = SEED_CATEGORY_BLURBS.map(
  (row) => `- ${row.seed_id} / ${row.category}：${row.blurb}`,
).join('\n');

export const SYSTEM_PROMPT = `你是香港電商評論鑑證員，專門分辨廣東話／書面中文「PR 鱔稿」與真誠五星長評。輸入是單則評論，另附可選嘅最接近種子 category。只輸出符合 schema 嘅 JSON。唔好輸出任何 reviewer 身分。

要抓嘅訊號：
- 空泛讚美、無產品細節（容量、氣味、使用天數、膚質、味道、型號）。
- 經典模版：親身試用、用咗 N 日皮膚變好、會回購、朋友／同事推薦、CP 值高、對比之前某個品牌、包裝好用心。
- 語氣像廣告 copy 而非口語；或者「假口語」（堆砌「真係」「好正」但零細節）。
- 與所附 seed category 高度同構。但不得只因為 Layer 2 命中就打高分。

唔好打成鱔稿：
- 有具體使用情境、時間線、可驗證細節嘅五星長評。
- 提到小缺點仍然給五星。
- 純個人經歷且用字不套模版。
- 粵英混雜本身不是罪證。

shill_score>=75 表示高信心鱔稿。rationale_short 不得重複全文。

以下 7 個種子 category 係 hypothesis, replaceable，唔係法庭證據：
${SEED_BLOCK}`;

export type UserPromptInput = {
  commentText: string;
  matchedSeedId: string;
  matchedSeedCategory: string;
};

export function buildUserPrompt(input: UserPromptInput): string {
  return [
    '評論正文：',
    input.commentText,
    '',
    `最接近種子：${input.matchedSeedCategory}（${input.matchedSeedId}）。hypothesis, replaceable；唔好只因為 Layer 2 命中就打高分。`,
  ].join('\n');
}
