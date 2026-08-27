-- SPDX-License-Identifier: GPL-3.0-only
-- v0 list is hypothesis, replaceable, not complete.

DELETE FROM `ecom_shill.logistics_canned_phrases`
WHERE phrase_version = 'v0';

INSERT INTO `ecom_shill.logistics_canned_phrases` (
  phrase_id,
  phrase,
  match_type,
  lang,
  category,
  is_active,
  phrase_version,
  notes
)
VALUES
  ('log_01', '送貨快', 'contains', 'yue', 'shipping_speed', TRUE, 'v0', NULL),
  ('log_02', '送貨好快', 'contains', 'yue', 'shipping_speed', TRUE, 'v0', NULL),
  ('log_03', '到貨快', 'contains', 'yue', 'shipping_speed', TRUE, 'v0', NULL),
  ('log_04', '好快收到', 'contains', 'yue', 'shipping_speed', TRUE, 'v0', NULL),
  ('log_05', '很快就收到', 'contains', 'yue', 'shipping_speed', TRUE, 'v0', NULL),
  ('log_06', '第二日就到', 'contains', 'yue', 'shipping_speed', TRUE, 'v0', NULL),
  ('log_07', '第二日送到', 'contains', 'yue', 'shipping_speed', TRUE, 'v0', NULL),
  ('log_08', '包裝完好', 'contains', 'yue', 'packaging', TRUE, 'v0', NULL),
  ('log_09', '包裝完好無損', 'contains', 'yue', 'packaging', TRUE, 'v0', NULL),
  ('log_10', '包裝好好', 'contains', 'yue', 'packaging', TRUE, 'v0', NULL),
  ('log_11', '包裝完整', 'contains', 'yue', 'packaging', TRUE, 'v0', NULL),
  ('log_12', '順豐好快', 'contains', 'yue', 'courier', TRUE, 'v0', NULL),
  ('log_13', '順豐', 'contains', 'yue', 'courier', TRUE, 'v0', NULL),
  ('log_14', '快遞好快', 'contains', 'yue', 'shipping_speed', TRUE, 'v0', NULL),
  ('log_15', '物流快', 'contains', 'yue', 'shipping_speed', TRUE, 'v0', NULL),
  ('log_16', '物流好快', 'contains', 'yue', 'shipping_speed', TRUE, 'v0', NULL),
  ('log_17', '運費', 'contains', 'yue', 'shipping_speed', TRUE, 'v0', NULL),
  ('log_18', '未拆已經好滿意', 'contains', 'yue', 'generic_thanks', TRUE, 'v0', NULL),
  ('log_19', '正品', 'contains', 'yue', 'generic_thanks', TRUE, 'v0', NULL),
  ('log_20', '好快就送到', 'contains', 'yue', 'shipping_speed', TRUE, 'v0', NULL),
  ('log_21', 'fast delivery', 'contains', 'en', 'shipping_speed', TRUE, 'v0', NULL),
  ('log_22', 'well packed', 'contains', 'en', 'packaging', TRUE, 'v0', NULL),
  ('log_23', '多謝賣家', 'contains', 'yue', 'generic_thanks', TRUE, 'v0', NULL),
  ('log_24', '賣家態度好', 'contains', 'yue', 'generic_thanks', TRUE, 'v0', NULL),
  ('log_25', '回覆得快', 'contains', 'yue', 'generic_thanks', TRUE, 'v0', NULL);
