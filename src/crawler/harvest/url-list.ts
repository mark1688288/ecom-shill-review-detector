// SPDX-License-Identifier: GPL-3.0-only
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { HktvmallUrlParseError, HarvestUsageError } from './errors.js';
import { parseHktvmallProductPath } from './hktvmall.js';

export type ParsedHarvestUrl = {
  href: string;
  host: string;
  store_id: string;
  product_id: string;
  source_url: string;
};

export function isAllowedHktvmallHost(hostname: string): boolean {
  const h = hostname.trim().toLowerCase();
  return h === 'www.hktvmall.com' || h === 'hktvmall.com';
}

export function assertHktvmallPublicProductUrl(raw: string): ParsedHarvestUrl {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new HktvmallUrlParseError(raw);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new HktvmallUrlParseError(raw);
  }
  if (!isAllowedHktvmallHost(parsed.hostname)) {
    throw new HktvmallUrlParseError(raw);
  }
  if (!parsed.pathname.includes('/hktv/zh/')) {
    throw new HktvmallUrlParseError(raw);
  }
  const ids = parseHktvmallProductPath(raw);
  if (ids === null) {
    throw new HktvmallUrlParseError(raw);
  }
  return {
    href: raw,
    host: parsed.hostname.trim().toLowerCase(),
    store_id: ids.store_id,
    product_id: ids.product_id,
    source_url: `${parsed.origin}${parsed.pathname}`,
  };
}

export function collectHarvestUrlStrings(opts: {
  urls: readonly string[];
  urlFile: string | undefined;
  cwd: string;
}): string[] {
  const collected = [...opts.urls];
  if (opts.urlFile !== undefined) {
    const abs = path.resolve(opts.cwd, opts.urlFile);
    let text: string;
    try {
      text = readFileSync(abs, 'utf8');
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new HarvestUsageError(`cannot read --url-file ${opts.urlFile}: ${detail}`);
    }
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.length === 0 || trimmed.startsWith('#')) {
        continue;
      }
      collected.push(trimmed);
    }
  }
  if (collected.length === 0) {
    throw new HarvestUsageError('harvest requires --url or --url-file');
  }
  return collected;
}

export function parseHarvestUrls(opts: {
  urls: readonly string[];
  urlFile: string | undefined;
  cwd: string;
}): ParsedHarvestUrl[] {
  return collectHarvestUrlStrings(opts).map((raw) => assertHktvmallPublicProductUrl(raw));
}
