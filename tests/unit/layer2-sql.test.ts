// SPDX-License-Identifier: GPL-3.0-only
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();

const V0_SEEDS = [
  {
    seed_id: 'seed_personal_trial',
    category: 'personal_trial',
    seed_text:
      '今次係我親身試用過先敢講，真係同廣告講嘅一樣，用落好舒服，效果好明顯。',
  },
  {
    seed_id: 'seed_skin_result',
    category: 'skin_result',
    seed_text:
      '用咗幾個禮拜，皮膚真係變好咗，暗瘡少咗，個 toning 都均淨晒，成個人都有光澤。',
  },
  {
    seed_id: 'seed_repurchase',
    category: 'repurchase',
    seed_text:
      '用完一枝已經決定回購，自己用完仲介紹俾屋企人，以後都會繼續支持呢個品牌。',
  },
  {
    seed_id: 'seed_social_proof',
    category: 'social_proof',
    seed_text: '朋友極力推薦我先買，佢用完話效果好好，我試過之後都覺得冇令我失望。',
  },
  {
    seed_id: 'seed_cp_value',
    category: 'value_for_money',
    seed_text: 'CP 值真係好高，呢個價已經買到咁好嘅質素，性價比超高，好抵用。',
  },
  {
    seed_id: 'seed_brand_compare',
    category: 'brand_comparison',
    seed_text: '對比之前用開嗰個品牌，呢隻明顯好好多，唔會再換返去舊嗰隻。',
  },
  {
    seed_id: 'seed_packaging',
    category: 'packaging_care',
    seed_text:
      '包裝好用心，一打開已經覺得好有質感，連細節都處理得好專業，賣家好有誠意。',
  },
] as const;

function readSql(relativePath: string): string {
  return readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function stripSqlComments(sql: string): string {
  return sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
}

function assertNoForbiddenMl(sql: string): void {
  const body = stripSqlComments(sql);
  expect(body).not.toMatch(/ML\.GENERATE_TEXT_EMBEDDING/i);
  expect(body).not.toMatch(/AI\.GENERATE_EMBEDDING/i);
  expect(body).not.toMatch(/AI\.EMBED\b/i);
}

describe('v0 PR seed phrases', () => {
  const seed = readSql('sql/seeds/pr_seed_phrases_v0.sql');

  it('labels the list as v0_hypothesis and hypothesis, replaceable', () => {
    expect(seed).toMatch(/v0_hypothesis/);
    expect(seed).toMatch(/hypothesis, replaceable/);
    expect(readFileSync(path.join(ROOT, 'README.md'), 'utf8')).toMatch(
      /hypothesis, replaceable/,
    );
  });

  it('inserts exactly the seven design-doc slots', () => {
    expect(V0_SEEDS).toHaveLength(7);
    const categories = new Set(V0_SEEDS.map((row) => row.category));
    const ids = new Set(V0_SEEDS.map((row) => row.seed_id));
    expect(categories.size).toBe(7);
    expect(ids.size).toBe(7);
    for (const row of V0_SEEDS) {
      expect(seed).toContain(row.seed_id);
      expect(seed).toContain(row.category);
      expect(seed).toContain(row.seed_text);
    }
    expect(seed).toMatch(/seed_version = 'v0_hypothesis'/);
    expect(seed).toMatch(/DELETE FROM `ecom_shill\.pr_seed_phrases`/);
    expect(seed.indexOf('DELETE FROM')).toBeLessThan(seed.indexOf('INSERT INTO'));
  });
});

describe('Layer 2 DDL', () => {
  it('ships seed, embedding, and stage2 tables', () => {
    const phrases = readSql('sql/ddl/04_pr_seed_phrases.sql');
    const reviews = readSql('sql/ddl/07_review_embeddings.sql');
    const seeds = readSql('sql/ddl/08_seed_embeddings.sql');
    const stage2 = readSql('sql/ddl/09_stage2_suspicious.sql');

    expect(phrases).toContain('CREATE TABLE IF NOT EXISTS `ecom_shill.pr_seed_phrases`');
    expect(phrases).toContain('seed_version STRING NOT NULL');

    expect(reviews).toContain('CREATE TABLE IF NOT EXISTS `ecom_shill.review_embeddings`');
    expect(reviews).toContain('embedding ARRAY<FLOAT64> NOT NULL');
    expect(reviews).toContain("status STRING NOT NULL");
    expect(reviews).toContain('PARTITION BY DATE(embedded_at)');
    expect(reviews).toContain('CLUSTER BY pipeline_run_id, store_id');

    expect(seeds).toContain('CREATE TABLE IF NOT EXISTS `ecom_shill.seed_embeddings`');
    expect(seeds).toContain('seed_version STRING NOT NULL');
    expect(seeds).not.toMatch(/PARTITION BY/);

    expect(stage2).toContain(
      'CREATE TABLE IF NOT EXISTS `ecom_shill.stage2_suspicious_for_gemini`',
    );
    expect(stage2).toContain('PRIMARY KEY (pipeline_run_id, review_id) NOT ENFORCED');
    expect(stage2).toContain('min_cosine_distance FLOAT64 NOT NULL');
    expect(stage2).toContain('min_cosine_similarity FLOAT64 NOT NULL');
    expect(stage2).toContain('CREATE OR REPLACE VIEW `ecom_shill.v_stage2_latest`');
    expect(stage2).toContain("phase = 'layer2'");
  });

  it('does not ship a Vertex remote-model DDL in this PR', () => {
    expect(existsSync(path.join(ROOT, 'sql/ddl/06_remote_models.sql'))).toBe(false);
  });

  it('does not commit a Vertex-dependent stage2 golden', () => {
    expect(existsSync(path.join(ROOT, 'fixtures/expected/stage2_review_ids.json'))).toBe(
      false,
    );
  });
});

describe('Layer 2 SQL jobs (files only; CI does not run ML)', () => {
  const embedReviews = readSql('sql/layer2/embed_reviews.sql');
  const embedSeeds = readSql('sql/layer2/embed_seeds.sql');
  const distance = readSql('sql/layer2/distance_filter.sql');

  it('embeds with ML.GENERATE_EMBEDDING and SEMANTIC_SIMILARITY', () => {
    for (const sql of [embedReviews, embedSeeds]) {
      expect(sql).toMatch(/ML\.GENERATE_EMBEDDING\s*\(/);
      expect(sql).toContain('MODEL `ecom_shill.text_embedding`');
      expect(sql).toContain("'SEMANTIC_SIMILARITY' AS task_type");
      expect(sql).toContain('TRUE AS flatten_json_output');
      assertNoForbiddenMl(sql);
    }
  });

  it('writes review error rows as empty FLOAT64 arrays, never NULL embeddings', () => {
    expect(embedReviews).toContain('IFNULL(ml_generate_embedding_result, ARRAY<FLOAT64>[])');
    expect(embedReviews).toContain("'error'");
    expect(embedReviews).toContain("'ok'");
    expect(embedReviews).toContain('ml_generate_embedding_status');
    expect(embedReviews).not.toMatch(/embedding\s*=\s*NULL/);
    expect(embedReviews).toContain('LEFT(s.comment_text, 1500)');
  });

  it('invalidates stale review vectors with EXISTS on content_hash mismatch', () => {
    expect(embedReviews).toMatch(/DELETE FROM `ecom_shill\.review_embeddings`/);
    expect(embedReviews).toContain('s.content_hash != e.content_hash');
    expect(embedReviews).toMatch(/AND EXISTS \(/);
    expect(embedReviews.indexOf('DELETE FROM')).toBeLessThan(
      embedReviews.indexOf('INSERT INTO'),
    );
    expect(embedReviews).toContain("status = 'ok'");
  });

  it('embeds only active seeds for @seed_version and replaces that model version', () => {
    expect(embedSeeds).toContain('seed_text AS content');
    expect(embedSeeds).toContain('AND is_active = TRUE');
    expect(embedSeeds).toContain('WHERE seed_version = @seed_version');
    expect(embedSeeds).toMatch(/DELETE FROM `ecom_shill\.seed_embeddings`/);
    expect(embedSeeds.indexOf('DELETE FROM')).toBeLessThan(embedSeeds.indexOf('INSERT INTO'));
  });

  it('rebuilds stage2 per pipeline_run_id using cosine distance <= @threshold', () => {
    expect(distance).toMatch(/DELETE FROM `ecom_shill\.stage2_suspicious_for_gemini`/);
    expect(distance).toContain('WHERE pipeline_run_id = @pipeline_run_id');
    expect(distance.indexOf('DELETE FROM')).toBeLessThan(distance.indexOf('INSERT INTO'));
    expect(distance).toContain("ML.DISTANCE(r.embedding, se.embedding, 'COSINE')");
    expect(distance).toContain('AND cosine_distance <= @threshold');
    expect(distance).toContain(
      'ROW_NUMBER() OVER (PARTITION BY review_id ORDER BY cosine_distance ASC, seed_id ASC)',
    );
    expect(distance).toContain('1 - cosine_distance AS min_cosine_similarity');
    expect(distance).toContain("r.status = 'ok'");
    expect(distance).not.toMatch(/CREATE OR REPLACE TABLE/i);
    assertNoForbiddenMl(distance);
  });
});

describe('bq-apply.sh Layer 2', () => {
  it('applies 04, 07–09 and v0 seeds after Layer 1, skipping remote models', () => {
    const script = readSql('scripts/bq-apply.sh');
    expect(script).toContain('04_pr_seed_phrases.sql');
    expect(script).toContain('07_review_embeddings.sql');
    expect(script).toContain('08_seed_embeddings.sql');
    expect(script).toContain('09_stage2_suspicious.sql');
    expect(script).toContain('pr_seed_phrases_v0.sql');
    expect(script).not.toMatch(/apply_sql "\$\{DDL_DIR\}\/06_/);
    expect(script.indexOf('05b_layer1_exclusion_audit.sql')).toBeLessThan(
      script.indexOf('07_review_embeddings.sql'),
    );
    expect(script.indexOf('07_review_embeddings.sql')).toBeLessThan(
      script.indexOf('08_seed_embeddings.sql'),
    );
    expect(script.indexOf('08_seed_embeddings.sql')).toBeLessThan(
      script.indexOf('09_stage2_suspicious.sql'),
    );
    expect(script.indexOf('09_stage2_suspicious.sql')).toBeLessThan(
      script.indexOf('pr_seed_phrases_v0.sql'),
    );
  });
});
