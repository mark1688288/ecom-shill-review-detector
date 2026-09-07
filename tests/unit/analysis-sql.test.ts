// SPDX-License-Identifier: GPL-3.0-only
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();

function readSql(relativePath: string): string {
  return readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function stripSqlComments(sql: string): string {
  return sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
}

const storeStats = readSql('sql/analysis/store_shill_stats.sql');
const burst = readSql('sql/analysis/burst_events.sql');
const template = readSql('sql/analysis/cross_store_collisions.sql');
const semantic = readSql('sql/analysis/semantic_collisions.sql');
const edges = readSql('sql/analysis/shill_network_edges.sql');
const funnel = readSql('sql/analysis/funnel_counts.sql');

describe('analysis SQL contracts', () => {
  it('parameterizes every script on @pipeline_run_id', () => {
    for (const sql of [storeStats, burst, template, semantic, edges, funnel]) {
      expect(sql).toContain('@pipeline_run_id');
      expect(sql).not.toMatch(/ORDER BY finished_at DESC LIMIT 1/);
    }
  });

  it('deletes the run before insert for rebuildable tables', () => {
    for (const [name, sql] of [
      ['store', storeStats],
      ['burst', burst],
      ['template', template],
      ['edges', edges],
      ['funnel', funnel],
    ] as const) {
      expect(sql.indexOf('DELETE FROM'), name).toBeGreaterThanOrEqual(0);
      expect(sql.indexOf('DELETE FROM'), name).toBeLessThan(sql.indexOf('INSERT INTO'));
      expect(sql).toMatch(/DELETE FROM[\s\S]+WHERE pipeline_run_id = @pipeline_run_id/);
    }
  });

  it('does not DELETE in semantic_collisions (template script already cleared the run)', () => {
    expect(stripSqlComments(semantic)).not.toMatch(/DELETE FROM/i);
    expect(semantic).toContain('pair_type');
    expect(semantic).toContain("'embedding'");
  });

  it('filters template collisions on this run, store_id_a < store_id_b, and drops unlisted_template', () => {
    expect(template).toContain('a.store_id < b.store_id');
    expect(template).toContain("a.template_id != 'unlisted_template'");
    expect(template).toContain('a.shill_score >= @shill_score_threshold');
    expect(template).toContain('b.shill_score >= @shill_score_threshold');
    expect(template).toContain('a.pipeline_run_id = b.pipeline_run_id');
    expect(template).toContain('WHERE a.pipeline_run_id = @pipeline_run_id');
    expect(template).toContain("'template'");
  });

  it('joins stage2 embeddings only (no stage1 pairwise) with cosine distance <= @threshold', () => {
    const body = stripSqlComments(semantic);
    expect(body).toContain('stage2_suspicious_for_gemini');
    expect(body).toContain('review_embeddings');
    expect(body).toContain("ML.DISTANCE(ea.embedding, eb.embedding, 'COSINE')");
    expect(body).toContain('WHERE cosine_distance <= @threshold');
    expect(body).toContain('a.store_id < b.store_id');
    expect(body).not.toMatch(/stage1_filtered/);
    expect(body).not.toMatch(/ML\.GENERATE_TEXT_EMBEDDING/i);
    expect(body).not.toMatch(/AI\.GENERATE_EMBEDDING/i);
  });

  it('builds edges from collisions grouped by ordered store pair', () => {
    expect(edges).toContain('store_id_a AS src_store_id');
    expect(edges).toContain('store_id_b AS dst_store_id');
    expect(edges).toContain('ARRAY_AGG(DISTINCT template_id IGNORE NULLS)');
    expect(edges).toContain('COUNT(*) AS weight');
  });

  it('treats funnel percentages as informational, not a CI SLA', () => {
    expect(funnel).toMatch(/not CI SLA/i);
    expect(funnel).toContain('SAFE_DIVIDE(n_stage1, n_raw)');
    expect(funnel).toContain('SAFE_DIVIDE(n_stage2, n_raw)');
    expect(funnel).not.toMatch(/0\.35/);
    expect(funnel).not.toMatch(/0\.05/);
  });

  it('scopes funnel stage counts to this run raw_reviews review_ids', () => {
    expect(funnel).toContain('WITH in_scope AS');
    expect(funnel).toContain('SELECT review_id');
    expect(funnel).toContain('FROM `ecom_shill.raw_reviews`');
    expect(funnel).toContain('review_id IN (SELECT review_id FROM in_scope)');
    expect(funnel).toContain('(SELECT COUNT(*) FROM in_scope) AS n_raw');
    const body = stripSqlComments(funnel);
    const nStage1 = body.slice(body.indexOf('stage1_filtered'), body.indexOf('AS n_stage1'));
    expect(nStage1).toContain('review_id IN');
    const nStage2 = body.slice(body.indexOf('stage2_suspicious_for_gemini'), body.indexOf('AS n_stage2'));
    expect(nStage2).toContain('review_id IN');
    const nAssessed = body.slice(
      body.indexOf('gemini_review_assessments'),
      body.indexOf('AS n_assessed'),
    );
    expect(nAssessed).toContain('review_id IN');
    const nAssessErrors = body.slice(
      body.indexOf('gemini_assessment_errors'),
      body.indexOf('AS n_assess_errors'),
    );
    expect(nAssessErrors).toContain('review_id IN');
    expect(nAssessErrors).toContain('pipeline_run_id = @pipeline_run_id');
    const nRaw = body.slice(body.indexOf('counts AS ('), body.indexOf('AS n_raw'));
    expect(nRaw).toMatch(/COUNT\(\*\) FROM in_scope|raw_reviews[\s\S]*pipeline_run_id = @pipeline_run_id/);
  });

  it('computes pct_shill_75 from shill_score >= @shill_score_threshold', () => {
    expect(storeStats).toContain('COUNTIF(shill_score >= @shill_score_threshold) AS n_shill_75');
    expect(storeStats).toContain('SAFE_DIVIDE(assessed.n_shill_75, assessed.n_assessed) AS pct_shill_75');
    expect(storeStats).toContain('AVG(min_cosine_distance) AS avg_min_seed_distance');
  });

  it('scopes store stage1/stage2/assessed CTEs to in-scope review_ids', () => {
    const body = stripSqlComments(storeStats);
    expect(body).toMatch(
      /raw AS \(\s*SELECT[\s\S]*?FROM `ecom_shill\.raw_reviews`\s+WHERE pipeline_run_id = @pipeline_run_id/,
    );
    const inScope = /review_id IN \(\s*SELECT review_id FROM `ecom_shill\.raw_reviews`\s+WHERE pipeline_run_id = @pipeline_run_id\s*\)/;
    const stage1 = body.slice(body.indexOf('stage1 AS ('), body.indexOf('stage2 AS ('));
    expect(stage1).toMatch(inScope);
    const stage2 = body.slice(body.indexOf('stage2 AS ('), body.indexOf('assessed AS ('));
    expect(stage2).toMatch(inScope);
    const assessed = body.slice(body.indexOf('assessed AS ('), body.lastIndexOf('SELECT'));
    expect(assessed).toMatch(inScope);
    expect(storeStats).toContain('LEFT JOIN stage1 ON stage1.store_id = raw.store_id');
  });

  it('uses sample stddev and the documented burst cutoffs', () => {
    expect(burst).toContain('STDDEV_SAMP');
    expect(burst).toContain('INTERVAL 14 DAY');
    expect(burst).toContain('baseline_days < 5');
    expect(burst).toContain('n_reviews >= 10');
    expect(burst).toContain('n_reviews >= 8');
    expect(burst).toContain('SAFE_DIVIDE(n_five_star, n_reviews) >= 0.9');
    expect(burst).toContain("'day' AS granularity");
    expect(burst).toContain("'hour' AS granularity");
    expect(burst).toContain('CAST(NULL AS STRING) AS product_id');
  });
});

describe('analysis DDL + bq-apply', () => {
  it('ships DDL 12–16', () => {
    const files = [
      'sql/ddl/12_store_shill_stats.sql',
      'sql/ddl/13_burst_events.sql',
      'sql/ddl/14_cross_store_template_collisions.sql',
      'sql/ddl/15_shill_network_edges.sql',
      'sql/ddl/16_funnel_stats.sql',
    ];
    for (const file of files) {
      expect(existsSync(path.join(ROOT, file)), file).toBe(true);
      expect(readSql(file)).toMatch(/CREATE TABLE IF NOT EXISTS/);
    }
  });

  it('applies 12–16 after assessments and before remote-model 06', () => {
    const script = readSql('scripts/bq-apply.sh');
    expect(script.indexOf('11_gemini_assessment_errors.sql')).toBeLessThan(
      script.indexOf('12_store_shill_stats.sql'),
    );
    expect(script.indexOf('12_store_shill_stats.sql')).toBeLessThan(
      script.indexOf('13_burst_events.sql'),
    );
    expect(script.indexOf('13_burst_events.sql')).toBeLessThan(
      script.indexOf('14_cross_store_template_collisions.sql'),
    );
    expect(script.indexOf('14_cross_store_template_collisions.sql')).toBeLessThan(
      script.indexOf('15_shill_network_edges.sql'),
    );
    expect(script.indexOf('15_shill_network_edges.sql')).toBeLessThan(
      script.indexOf('16_funnel_stats.sql'),
    );
    expect(script.indexOf('16_funnel_stats.sql')).toBeLessThan(script.indexOf('06_remote_models.sql'));
  });
});
