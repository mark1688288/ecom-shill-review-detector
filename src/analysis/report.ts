// SPDX-License-Identifier: GPL-3.0-only
import path from 'node:path';

export const DISCLAIMER_ZH = '統計 ≠ 法律事實';
export const DISCLAIMER_EN = 'Statistics are not legal facts.';

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

export type ReportData = {
  pipeline_run_id: string;
  funnel: FunnelStatsRow | null;
  stores: StoreShillStatsRow[];
  bursts: BurstEventRow[];
  edges: NetworkEdgeRow[];
};

export function formatPct(value: number | null): string {
  if (value === null) {
    return 'n/a';
  }
  return `${(value * 100).toFixed(1)}%`;
}

function formatNum(value: number | null, digits = 3): string {
  if (value === null) {
    return 'n/a';
  }
  return value.toFixed(digits);
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
