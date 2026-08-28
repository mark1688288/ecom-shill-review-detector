-- SPDX-License-Identifier: GPL-3.0-only
-- v0_hypothesis seed phrases: hypothesis, replaceable, not an empirically
-- validated "official 7". Insert a new seed_version instead of overwriting.

DELETE FROM `ecom_shill.pr_seed_phrases`
WHERE seed_version = 'v0_hypothesis';

INSERT INTO `ecom_shill.pr_seed_phrases` (
  seed_id,
  category,
  seed_text,
  seed_version,
  is_active,
  created_at
)
VALUES
  (
    'seed_personal_trial',
    'personal_trial',
    '今次係我親身試用過先敢講，真係同廣告講嘅一樣，用落好舒服，效果好明顯。',
    'v0_hypothesis',
    TRUE,
    CURRENT_TIMESTAMP()
  ),
  (
    'seed_skin_result',
    'skin_result',
    '用咗幾個禮拜，皮膚真係變好咗，暗瘡少咗，個 toning 都均淨晒，成個人都有光澤。',
    'v0_hypothesis',
    TRUE,
    CURRENT_TIMESTAMP()
  ),
  (
    'seed_repurchase',
    'repurchase',
    '用完一枝已經決定回購，自己用完仲介紹俾屋企人，以後都會繼續支持呢個品牌。',
    'v0_hypothesis',
    TRUE,
    CURRENT_TIMESTAMP()
  ),
  (
    'seed_social_proof',
    'social_proof',
    '朋友極力推薦我先買，佢用完話效果好好，我試過之後都覺得冇令我失望。',
    'v0_hypothesis',
    TRUE,
    CURRENT_TIMESTAMP()
  ),
  (
    'seed_cp_value',
    'value_for_money',
    'CP 值真係好高，呢個價已經買到咁好嘅質素，性價比超高，好抵用。',
    'v0_hypothesis',
    TRUE,
    CURRENT_TIMESTAMP()
  ),
  (
    'seed_brand_compare',
    'brand_comparison',
    '對比之前用開嗰個品牌，呢隻明顯好好多，唔會再換返去舊嗰隻。',
    'v0_hypothesis',
    TRUE,
    CURRENT_TIMESTAMP()
  ),
  (
    'seed_packaging',
    'packaging_care',
    '包裝好用心，一打開已經覺得好有質感，連細節都處理得好專業，賣家好有誠意。',
    'v0_hypothesis',
    TRUE,
    CURRENT_TIMESTAMP()
  );
