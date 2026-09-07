// SPDX-License-Identifier: GPL-3.0-only
import path from 'node:path';
import { SHILL_SCORE_THRESHOLD } from './collisions.js';

export const DISCLAIMER_ZH = '統計 ≠ 法律事實';
export const DISCLAIMER_EN = 'Statistics are not legal facts.';

export const ASCII_BAR_WIDTH = 20;

export const L1_HIST_BUCKETS = [
  'non_five_star',
  'too_short',
  'pure_logistics',
  'pass',
] as const;

export const L3_HIST_BUCKETS = ['0-24', '25-49', '50-74', '75-100'] as const;

const L1_HIST_BUCKET_SET: ReadonlySet<string> = new Set(L1_HIST_BUCKETS);

export type ReportFormat = 'markdown' | 'json';

export type FunnelStatsRow = {
  pipeline_run_id: string;
  n_raw: number;
  n_stage1: number;
  n_stage2: number;
  n_assessed: number;
  n_assess_errors: number;
  pct_stage1: number | null;
  pct_stage2_of_raw: number | null;
  pct_stage2_of_stage1: number | null;
};

export type StoreShillStatsRow = {
  store_id: string;
  marketplace: string;
  n_raw: number;
  n_stage1: number;
  n_stage2: number;
  n_assessed: number;
  n_shill_75: number;
  pct_shill_75: number | null;
  n_template_hit: number | null;
  template_hit_rate: number | null;
  avg_min_seed_distance: number | null;
  p50_shill_score: number | null;
};

export type BurstEventRow = {
  store_id: string;
  product_id: string | null;
  bucket_ts: string;
  granularity: string;
  n_reviews: number;
  n_five_star: number;
  z_score: number | null;
  is_burst: boolean;
};

export type NetworkEdgeRow = {
  src_store_id: string;
  dst_store_id: string;
  weight: number;
  template_ids: string[];
};

export type HistogramBucket = { bucket: string; n: number };

export type ScoreHistograms = {
  n_in_scope: number;
  layer1: {
    metric: 'exclusion_reason';
    buckets: HistogramBucket[];
    n_rows: number;
    unknown_n: number;
    coverage_ok: boolean;
  };
  layer2: {
    metric: 'min_cosine_distance';
    threshold: number;
    threshold_source: 'pipeline_runs' | 'config_fallback';
    buckets: HistogramBucket[];
    n_with_distance: number;
    n_no_distance: number;
    n_le_threshold: number;
    n_gt_threshold: number;
  };
  layer3: {
    metric: 'shill_score';
    threshold: number;
    buckets: HistogramBucket[];
    n_assessed: number;
    n_gemini: number;
    n_copied: number;
    n_shill_75: number;
  };
};

export type ReportData = {
  pipeline_run_id: string;
  funnel: FunnelStatsRow | null;
  stores: StoreShillStatsRow[];
  bursts: BurstEventRow[];
  edges: NetworkEdgeRow[];
  score_histograms: ScoreHistograms;
};

export function formatPct(value: number | null): string {
  if (value === null) {
    return 'n/a';
  }
  return `${(value * 100).toFixed(1)}%`;
}

export function formatHistogramPct(n: number, total: number): string {
  if (total <= 0) {
    return 'n/a';
  }
  return formatPct(n / total);
}

function formatNum(value: number | null, digits = 3): string {
  if (value === null) {
    return 'n/a';
  }
  return value.toFixed(digits);
}

export function l2BinEdges(
  threshold: number,
): [number, number, number, number, number, number] {
  return [threshold / 4, threshold / 2, (3 * threshold) / 4, threshold, 1, 2];
}

function l2BucketLabels(threshold: number): string[] {
  const [q1, q2, q3, t, one, two] = l2BinEdges(threshold);
  // toFixed(2) only for ids; 3T/4 at T=0.28 is 0.21000000000000002.
  return [
    `${(0).toFixed(2)}-${q1.toFixed(2)}`,
    `${q1.toFixed(2)}-${q2.toFixed(2)}`,
    `${q2.toFixed(2)}-${q3.toFixed(2)}`,
    `${q3.toFixed(2)}-${t.toFixed(2)}`,
    `${t.toFixed(2)}-${one.toFixed(2)}`,
    `${one.toFixed(2)}-${two.toFixed(2)}`,
  ];
}

export function binL2Distances(
  values: readonly number[],
  threshold: number,
): { buckets: HistogramBucket[] } {
  const [e0, e1, e2, e3, e4] = l2BinEdges(threshold);
  const labels = l2BucketLabels(threshold);
  const counts: [number, number, number, number, number, number] = [0, 0, 0, 0, 0, 0];
  let outOfRange = 0;
  for (const d of values) {
    if (!Number.isFinite(d) || d < 0 || d > 2) {
      outOfRange += 1;
      continue;
    }
    if (d < e0) {
      counts[0] += 1;
    } else if (d < e1) {
      counts[1] += 1;
    } else if (d < e2) {
      counts[2] += 1;
    } else if (d <= e3) {
      // Right-closed so d === T stays in the in-range quartiles, not (T,1].
      counts[3] += 1;
    } else if (d <= e4) {
      counts[4] += 1;
    } else {
      counts[5] += 1;
    }
  }
  const buckets: HistogramBucket[] = labels.map((bucket, i) => ({
    bucket,
    n: counts[i] ?? 0,
  }));
  if (outOfRange > 0) {
    buckets.push({ bucket: 'out_of_range', n: outOfRange });
  }
  return { buckets };
}

export function binL3Scores(values: readonly number[]): { buckets: HistogramBucket[] } {
  const counts: [number, number, number, number] = [0, 0, 0, 0];
  let outOfRange = 0;
  for (const score of values) {
    if (!Number.isFinite(score) || score < 0 || score > 100) {
      outOfRange += 1;
      continue;
    }
    if (score <= 24) {
      counts[0] += 1;
    } else if (score <= 49) {
      counts[1] += 1;
    } else if (score <= 74) {
      counts[2] += 1;
    } else {
      counts[3] += 1;
    }
  }
  const buckets: HistogramBucket[] = L3_HIST_BUCKETS.map((bucket, i) => ({
    bucket,
    n: counts[i] ?? 0,
  }));
  if (outOfRange > 0) {
    buckets.push({ bucket: 'out_of_range', n: outOfRange });
  }
  return { buckets };
}

export function fillL1HistogramBuckets(
  rows: readonly HistogramBucket[],
): { buckets: HistogramBucket[]; unknown_n: number } {
  const nBy = new Map<string, number>();
  let unknown_n = 0;
  for (const row of rows) {
    if (L1_HIST_BUCKET_SET.has(row.bucket)) {
      nBy.set(row.bucket, (nBy.get(row.bucket) ?? 0) + row.n);
    } else {
      unknown_n += row.n;
    }
  }
  return {
    buckets: L1_HIST_BUCKETS.map((bucket) => ({ bucket, n: nBy.get(bucket) ?? 0 })),
    unknown_n,
  };
}

export function renderAsciiBar(n: number, maxN: number): string {
  if (n <= 0 || maxN <= 0) {
    return ' '.repeat(ASCII_BAR_WIDTH);
  }
  return '█'.repeat(Math.round((n / maxN) * ASCII_BAR_WIDTH));
}

function appendHistogramTable(
  lines: string[],
  buckets: readonly HistogramBucket[],
  totalForPct: number,
  pctHeader: string,
): void {
  lines.push(`| bucket | n | ${pctHeader} | |`);
  lines.push('| --- | ---: | ---: | --- |');
  let maxN = 0;
  for (const row of buckets) {
    if (row.n > maxN) {
      maxN = row.n;
    }
  }
  for (const row of buckets) {
    lines.push(
      `| ${row.bucket} | ${String(row.n)} | ${formatHistogramPct(row.n, totalForPct)} | ${renderAsciiBar(row.n, maxN)} |`,
    );
  }
}

function appendScoreDistributions(lines: string[], data: ReportData): void {
  const hist = data.score_histograms;
  lines.push('## Score distributions');
  lines.push('');
  lines.push(
    `Histograms are statistical indicators, not accusations. \`n_in_scope=${String(hist.n_in_scope)}\`. Run-level only.`,
  );
  if (!hist.layer1.coverage_ok) {
    lines.push('');
    lines.push(
      `> Layer 1 coverage gap: n_rows=${String(hist.layer1.n_rows)} vs n_in_scope=${String(hist.n_in_scope)}`,
    );
  }
  lines.push('');
  lines.push('### Layer 1 — `exclusion_reason`');
  lines.push('');
  lines.push(
    'No numeric `shill_score` at this layer. Priority: non_five_star > too_short (`CHAR_LENGTH` < 25) > pure_logistics > pass.',
  );
  lines.push('');
  appendHistogramTable(lines, hist.layer1.buckets, hist.n_in_scope, 'of in-scope');
  lines.push('');
  lines.push('### Layer 2 — `min_cosine_distance`');
  lines.push('');
  const tLabel = hist.layer2.threshold.toFixed(2);
  lines.push(
    `Cosine **distance** from \`layer2_distance_audit\` (all nearest-seed \`rn=1\` rows). Stage2 / Gemini still only \`<= ${tLabel}\`. Bars include mass **above** T. \`no_distance\` = no stage2-quality distance row (embed missing/error, or no matching seed) — v1 does not split.`,
  );
  lines.push('');
  appendHistogramTable(
    lines,
    hist.layer2.buckets,
    hist.layer2.n_with_distance + hist.layer2.n_no_distance,
    'of stage1-in-scope',
  );
  lines.push('');
  lines.push('### Layer 3 — `shill_score`');
  lines.push('');
  lines.push(
    `Gemini \`shill_score\` 0–100. \`75-100\` is the in-scope \`n_shill_75\` bucket (\`SHILL_SCORE_THRESHOLD=${String(SHILL_SCORE_THRESHOLD)}\`). Includes \`score_source=copied\`. \`n_assessed=${String(hist.layer3.n_assessed)}\` (\`n_gemini=${String(hist.layer3.n_gemini)}\`, \`n_copied=${String(hist.layer3.n_copied)}\`). \`pct_shill_75\` uses this n, not \`n_raw\`.`,
  );
  lines.push('');
  appendHistogramTable(lines, hist.layer3.buckets, hist.layer3.n_assessed, 'of assessed');
  lines.push('');
}

export function renderMarkdown(data: ReportData): string {
  const lines: string[] = [];
  lines.push(`# Shill review analysis`);
  lines.push('');
  lines.push(`> **${DISCLAIMER_ZH}** / ${DISCLAIMER_EN}`);
  lines.push('>');
  lines.push(
    '> This report is a personal research / analysis tool. Scores, bursts, and collisions are statistical indicators, not legal facts or public accusations.',
  );
  lines.push('');
  lines.push(`pipeline_run_id: \`${data.pipeline_run_id}\``);
  lines.push('');
  lines.push('## Funnel');
  lines.push('');
  if (data.funnel === null) {
    lines.push('No funnel_stats row for this run. Run `ecom-shill analyze` first.');
  } else {
    const f = data.funnel;
    lines.push('| layer | n | of raw |');
    lines.push('| --- | ---: | ---: |');
    lines.push(`| raw | ${String(f.n_raw)} | 100% |`);
    lines.push(`| stage1 | ${String(f.n_stage1)} | ${formatPct(f.pct_stage1)} |`);
    lines.push(`| stage2 | ${String(f.n_stage2)} | ${formatPct(f.pct_stage2_of_raw)} |`);
    lines.push(`| assessed | ${String(f.n_assessed)} | — |`);
    lines.push(`| assess errors | ${String(f.n_assess_errors)} | — |`);
    lines.push('');
    lines.push(`stage2 / stage1: ${formatPct(f.pct_stage2_of_stage1)}`);
  }
  lines.push('');
  lines.push(
    '> Funnel `n_raw` / `n_stage1` / `n_stage2` / `n_assessed` use the same in-scope `review_id` set as the score charts (`raw_reviews` for this `pipeline_run_id`). If `n_raw` disagrees with live `n_in_scope`, re-run analyze.',
  );
  if (data.funnel !== null && data.score_histograms.n_in_scope !== data.funnel.n_raw) {
    lines.push('>');
    lines.push('> funnel `n_raw` stale vs live `raw_reviews`; re-run analyze');
  }
  lines.push('');
  appendScoreDistributions(lines, data);
  lines.push('## Top stores by pct_shill_75');
  lines.push('');
  if (data.stores.length === 0) {
    lines.push('No store_shill_stats rows.');
  } else {
    lines.push(
      '| store_id | marketplace | n_raw | n_assessed | n_shill_75 | pct_shill_75 | template_hit_rate | avg_min_seed_distance |',
    );
    lines.push('| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |');
    const stores = [...data.stores].sort((a, b) => {
      const pa = a.pct_shill_75 ?? -1;
      const pb = b.pct_shill_75 ?? -1;
      if (pb !== pa) {
        return pb - pa;
      }
      return b.n_shill_75 - a.n_shill_75;
    });
    for (const store of stores) {
      lines.push(
        `| ${store.store_id} | ${store.marketplace} | ${String(store.n_raw)} | ${String(store.n_assessed)} | ${String(store.n_shill_75)} | ${formatPct(store.pct_shill_75)} | ${formatPct(store.template_hit_rate)} | ${formatNum(store.avg_min_seed_distance)} |`,
      );
    }
  }
  lines.push('');
  lines.push(
    '> **Denominator:** `pct_shill_75 = n_shill_75 / n_assessed` per store (Gemini assessment rows), not `n_shill_75 / n_raw`.',
  );
  lines.push('');
  lines.push('## Burst events');
  lines.push('');
  const bursts = data.bursts.filter((row) => row.is_burst);
  if (bursts.length === 0) {
    lines.push('No burst events.');
  } else {
    lines.push('| store_id | product_id | granularity | bucket_ts | n_reviews | n_five_star | z_score |');
    lines.push('| --- | --- | --- | --- | ---: | ---: | ---: |');
    for (const burst of bursts) {
      lines.push(
        `| ${burst.store_id} | ${burst.product_id ?? '—'} | ${burst.granularity} | ${burst.bucket_ts} | ${String(burst.n_reviews)} | ${String(burst.n_five_star)} | ${formatNum(burst.z_score)} |`,
      );
    }
  }
  lines.push('');
  lines.push('## Cross-store edges');
  lines.push('');
  if (data.edges.length === 0) {
    lines.push('No shill_network_edges rows.');
  } else {
    lines.push('| src_store_id | dst_store_id | weight | template_ids |');
    lines.push('| --- | --- | ---: | --- |');
    const edges = [...data.edges].sort((a, b) => b.weight - a.weight);
    for (const edge of edges) {
      const templates = edge.template_ids.length > 0 ? edge.template_ids.join(', ') : '—';
      lines.push(
        `| ${edge.src_store_id} | ${edge.dst_store_id} | ${String(edge.weight)} | ${templates} |`,
      );
    }
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

export function renderJson(data: ReportData): string {
  const payload = {
    disclaimer: DISCLAIMER_ZH,
    disclaimer_en: DISCLAIMER_EN,
    pipeline_run_id: data.pipeline_run_id,
    funnel: data.funnel,
    stores: data.stores,
    bursts: data.bursts.filter((row) => row.is_burst),
    edges: data.edges,
    score_histograms: data.score_histograms,
  };
  return `${JSON.stringify(payload, null, 2)}\n`;
}

function escapeDotId(id: string): string {
  return id.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

export function renderDot(data: ReportData): string {
  const lines = ['graph {', '  graph [overlap=false];'];
  const edges = [...data.edges].sort((a, b) => b.weight - a.weight);
  if (edges.length === 0) {
    lines.push('}');
    return `${lines.join('\n')}\n`;
  }
  for (const edge of edges) {
    lines.push(
      `  "${escapeDotId(edge.src_store_id)}" -- "${escapeDotId(edge.dst_store_id)}" [label=${String(edge.weight)}];`,
    );
  }
  lines.push('}');
  return `${lines.join('\n')}\n`;
}

export function looksLikeReportFile(outPath: string): boolean {
  return /\.(md|json|dot)$/i.test(outPath);
}

export function resolveReportOutputPaths(opts: {
  pipelineRunId: string;
  format: ReportFormat;
  out?: string;
  dot: boolean;
  cwd: string;
}): { primary: string; dotPath: string | undefined } {
  const ext = opts.format === 'json' ? '.json' : '.md';
  let primary: string;
  if (opts.out === undefined || opts.out === '') {
    primary = path.join(opts.cwd, 'reports', `${opts.pipelineRunId}${ext}`);
  } else {
    const resolved = path.resolve(opts.cwd, opts.out);
    if (looksLikeReportFile(opts.out)) {
      primary = resolved;
    } else {
      primary = path.join(resolved, `${opts.pipelineRunId}${ext}`);
    }
  }
  if (!opts.dot) {
    return { primary, dotPath: undefined };
  }
  const parsed = path.parse(primary);
  return { primary, dotPath: path.join(parsed.dir, `${parsed.name}.dot`) };
}

export function parseReportFormat(raw: string | undefined): ReportFormat {
  const value = raw ?? 'markdown';
  if (value === 'markdown' || value === 'json') {
    return value;
  }
  throw new Error('format must be markdown or json');
}
