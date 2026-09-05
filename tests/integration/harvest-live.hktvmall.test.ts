// SPDX-License-Identifier: GPL-3.0-only
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runHarvest } from '../../src/cli/commands/harvest.js';
import { parseFixtureReviewLine } from '../../src/crawler/types.js';

const liveEnabled =
  process.env['HARVEST_LIVE'] === '1' &&
  Boolean(process.env['BRIGHTDATA_BROWSERAPI_USERNAME']) &&
  Boolean(process.env['BRIGHTDATA_BROWSERAPI_PASSWORD']) &&
  Boolean(process.env['HARVEST_LIVE_URL']) &&
  process.env['CI'] !== 'true';

const tmpDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe.skipIf(!liveEnabled)('harvest live hktvmall (opt-in)', () => {
  it(
    'harvests FixtureReviewRaw JSONL from HARVEST_LIVE_URL',
    async () => {
      const url = process.env['HARVEST_LIVE_URL'];
      if (url === undefined || url.length === 0) {
        throw new Error('HARVEST_LIVE_URL missing despite skipIf gate');
      }
      const dir = await mkdtemp(path.join(os.tmpdir(), 'ecom-shill-harvest-live-'));
      tmpDirs.push(dir);
      const out = path.join(dir, 'live.jsonl');
      const result = await runHarvest({
        url: [url],
        iAcceptTos: true,
        out,
        cwd: dir,
        env: process.env,
        stdout: { write: () => true },
      });
      expect(result.ok).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.n_pages).toBeGreaterThanOrEqual(1);
      expect(result.n_accepted).toBeGreaterThanOrEqual(1);
      const body = await readFile(out, 'utf8');
      const lines = body.split('\n').filter((line) => line.length > 0);
      expect(lines.length).toBe(result.n_accepted);
      const first = parseFixtureReviewLine(lines[0] ?? '');
      expect(first.success).toBe(true);
      if (first.success) {
        expect(first.data.marketplace).toBe('hktvmall');
        expect(first.data).not.toHaveProperty('language_hint');
      }
    },
    8 * 60 * 1000,
  );
});
