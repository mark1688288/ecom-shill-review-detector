// SPDX-License-Identifier: GPL-3.0-only
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CALIBRATION_DISTANCE_THRESHOLDS } from '../../src/cli/commands/seeds.js';

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

describe('human_labels DDL', () => {
  const ddl = readSql('sql/ddl/human_labels.sql');

  it('creates human_labels and calibration_sweep', () => {
    expect(ddl).toContain('CREATE TABLE IF NOT EXISTS `ecom_shill.human_labels`');
    expect(ddl).toContain('CREATE TABLE IF NOT EXISTS `ecom_shill.calibration_sweep`');
    expect(ddl).toContain('label STRING NOT NULL');
    expect(ddl).toContain('PRIMARY KEY (pipeline_run_id, review_id) NOT ENFORCED');
    expect(ddl).toContain("metric_kind STRING NOT NULL");
    expect(ddl).toContain('estimated_gemini_usd FLOAT64');
  });

  it('does not auto-tune config defaults', () => {
    expect(ddl).toMatch(/hypothes/);
    expect(ddl).not.toMatch(/COSINE_DISTANCE_THRESHOLD/);
  });
});

describe('calibration SQL', () => {
  const sql = readSql('sql/analysis/calibration.sql');
  const body = stripSqlComments(sql);

  it('deletes the run before insert and parameterizes pipeline_run_id', () => {
    expect(sql).toContain('@pipeline_run_id');
    expect(sql.indexOf('DELETE FROM')).toBeGreaterThanOrEqual(0);
    expect(sql.indexOf('DELETE FROM')).toBeLessThan(sql.indexOf('INSERT INTO'));
    expect(sql).toMatch(
      /DELETE FROM[\s\S]+calibration_sweep[\s\S]+WHERE pipeline_run_id = @pipeline_run_id/,
    );
  });

  it('sweeps the design-doc distance grid', () => {
    expect(CALIBRATION_DISTANCE_THRESHOLDS).toEqual([0.18, 0.22, 0.25, 0.28, 0.32, 0.38]);
    expect(body).toContain('UNNEST([0.18, 0.22, 0.25, 0.28, 0.32, 0.38])');
  });

  it('joins labels to layer2_distance_audit and excludes unsure from TP/FP', () => {
    expect(body).toContain('layer2_distance_audit');
    expect(body).toContain('human_labels');
    expect(body).toContain("label IN ('shill', 'not_shill')");
    expect(body).toContain("label = 'unsure'");
    expect(body).toContain('SAFE_DIVIDE');
  });

  it('estimates Gemini cost from full-run predicted stage2, not only labeled rows', () => {
    expect(body).toContain('n_predicted_stage2');
    expect(body).toContain('* @usd_per_review');
    expect(body).toContain('stage2_suspicious_for_gemini');
    expect(body).toContain("'layer3_score'");
    expect(body).toContain('@shill_score_threshold');
    expect(body).toContain('@current_l2_threshold');
  });

  it('does not call embedding or generate APIs', () => {
    expect(body).not.toMatch(/ML\.GENERATE_EMBEDDING/i);
    expect(body).not.toMatch(/ML\.GENERATE_TEXT_EMBEDDING/i);
    expect(body).not.toMatch(/AI\.GENERATE_EMBEDDING/i);
    expect(body).not.toMatch(/ML\.GENERATE_TEXT/i);
  });
});

describe('bq-apply.sh Phase 5', () => {
  it('applies human_labels after funnel_stats', () => {
    const script = readSql('scripts/bq-apply.sh');
    expect(script).toContain('human_labels.sql');
    expect(script.indexOf('16_funnel_stats.sql')).toBeLessThan(script.indexOf('human_labels.sql'));
    expect(script.indexOf('human_labels.sql')).toBeLessThan(script.indexOf('pr_seed_phrases_v0.sql'));
  });
});
