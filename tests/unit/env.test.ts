// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
  assertSalt,
  BrightDataCredentialsError,
  commandRequiresGcp,
  loadBrightDataBrowserEnv,
  loadDefaultConfig,
  loadEnv,
  loadScrapingBeeEnv,
  ScrapingBeeCredentialsError,
} from '../../src/shared/env.js';

const VALID_SALT = '0123456789abcdef';

describe('assertSalt', () => {
  it('throws when salt is missing', () => {
    expect(() => assertSalt(undefined)).toThrow(/REVIEWER_ID_SALT/);
  });

  it('throws when salt is an empty string (never a silent default)', () => {
    expect(() => assertSalt('')).toThrow(/REVIEWER_ID_SALT/);
  });

  it('throws when salt is shorter than 16 characters', () => {
    expect(() => assertSalt('short-salt')).toThrow(/at least 16/);
  });

  it('accepts a 16-character salt', () => {
    expect(assertSalt(VALID_SALT)).toBe(VALID_SALT);
  });
});

describe('loadEnv', () => {
  it('loads crawl --dry-run with only REVIEWER_ID_SALT (no GCP_PROJECT)', () => {
    const loaded = loadEnv({
      command: 'crawl',
      dryRun: true,
      env: { REVIEWER_ID_SALT: VALID_SALT },
    });
    expect(loaded.hmac.REVIEWER_ID_SALT).toBe(VALID_SALT);
    expect(loaded.gcp).toBeUndefined();
    expect(loaded.config.layer2.embedding_model).toBe(
      'text-multilingual-embedding-002',
    );
  });

  it('throws on crawl dry-run when salt is missing', () => {
    expect(() =>
      loadEnv({
        command: 'crawl',
        dryRun: true,
        env: {},
      }),
    ).toThrow(/REVIEWER_ID_SALT/);
  });

  it('throws on crawl dry-run when salt is too short', () => {
    expect(() =>
      loadEnv({
        command: 'crawl',
        dryRun: true,
        env: { REVIEWER_ID_SALT: 'too-short' },
      }),
    ).toThrow(/REVIEWER_ID_SALT/);
  });

  it('does not require GCP_PROJECT for non-dry-run crawl', () => {
    const loaded = loadEnv({
      command: 'crawl',
      env: { REVIEWER_ID_SALT: VALID_SALT },
    });
    expect(loaded.gcp).toBeUndefined();
  });

  it('does not require GCP_PROJECT for seeds --dry-run', () => {
    const loaded = loadEnv({
      command: 'seeds',
      dryRun: true,
      env: { REVIEWER_ID_SALT: VALID_SALT },
    });
    expect(loaded.gcp).toBeUndefined();
  });

  it('requires GCP_PROJECT for live seeds', () => {
    expect(() =>
      loadEnv({
        command: 'seeds',
        env: { REVIEWER_ID_SALT: VALID_SALT },
      }),
    ).toThrow(/GCP_PROJECT/);
  });

  it('requires GCP_PROJECT for load', () => {
    expect(() =>
      loadEnv({
        command: 'load',
        env: { REVIEWER_ID_SALT: VALID_SALT },
      }),
    ).toThrow(/GCP_PROJECT/);
  });

  it('loads load when GCP vars are present', () => {
    const loaded = loadEnv({
      command: 'load',
      env: {
        REVIEWER_ID_SALT: VALID_SALT,
        GCP_PROJECT: 'demo-project',
        GCP_LOCATION: 'asia-east1',
        BQ_DATASET: 'ecom_shill',
      },
    });
    expect(loaded.gcp?.GCP_PROJECT).toBe('demo-project');
    expect(loaded.gcp?.GCP_LOCATION).toBe('asia-east1');
  });

  it('lets GEMINI_LOCATION differ from GCP_LOCATION', () => {
    const loaded = loadEnv({
      command: 'audit',
      env: {
        REVIEWER_ID_SALT: VALID_SALT,
        GCP_PROJECT: 'demo-project',
        GCP_LOCATION: 'asia-east1',
        BQ_DATASET: 'ecom_shill',
        GEMINI_LOCATION: 'global',
      },
    });
    expect(loaded.gcp?.GCP_LOCATION).toBe('asia-east1');
    expect(loaded.gcp?.GEMINI_LOCATION).toBe('global');
  });

  it('lets EMBEDDING_MODEL override yaml (004 is opt-in)', () => {
    const loaded = loadEnv({
      command: 'crawl',
      dryRun: true,
      env: {
        REVIEWER_ID_SALT: VALID_SALT,
        EMBEDDING_MODEL: 'text-embedding-004',
      },
    });
    expect(loaded.config.layer2.embedding_model).toBe('text-embedding-004');
  });
});

describe('commandRequiresGcp', () => {
  it('is false for dry-run regardless of command', () => {
    expect(commandRequiresGcp('load', true)).toBe(false);
    expect(commandRequiresGcp('audit', true)).toBe(false);
  });

  it('is false for crawl and harvest (GCP allow-list)', () => {
    expect(commandRequiresGcp('crawl', false)).toBe(false);
    expect(commandRequiresGcp('harvest', false)).toBe(false);
  });

  it('is false for seeds --dry-run and true for live seeds', () => {
    expect(commandRequiresGcp('seeds', true)).toBe(false);
    expect(commandRequiresGcp('seeds', false)).toBe(true);
  });

  it('is true for load and downstream commands', () => {
    expect(commandRequiresGcp('load', false)).toBe(true);
    expect(commandRequiresGcp('layer1', false)).toBe(true);
    expect(commandRequiresGcp('layer2', false)).toBe(true);
    expect(commandRequiresGcp('audit', false)).toBe(true);
    expect(commandRequiresGcp('analyze', false)).toBe(true);
    expect(commandRequiresGcp('report', false)).toBe(true);
  });
});

describe('loadBrightDataBrowserEnv', () => {
  it('reads username and password', () => {
    const loaded = loadBrightDataBrowserEnv({
      BRIGHTDATA_BROWSERAPI_USERNAME: 'brd-customer-x-zone-y',
      BRIGHTDATA_BROWSERAPI_PASSWORD: 'secret',
    });
    expect(loaded.username).toBe('brd-customer-x-zone-y');
    expect(loaded.password).toBe('secret');
  });

  it('throws when either credential is missing', () => {
    expect(() => loadBrightDataBrowserEnv({})).toThrow(BrightDataCredentialsError);
    expect(() =>
      loadBrightDataBrowserEnv({ BRIGHTDATA_BROWSERAPI_USERNAME: 'user' }),
    ).toThrow(BrightDataCredentialsError);
  });

  it('throws when username already ends in -country-xx', () => {
    expect(() =>
      loadBrightDataBrowserEnv({
        BRIGHTDATA_BROWSERAPI_USERNAME: 'user-country-hk',
        BRIGHTDATA_BROWSERAPI_PASSWORD: 'secret',
      }),
    ).toThrow(/country suffix/);
  });
});

describe('loadScrapingBeeEnv', () => {
  it('reads SCRAPINGBEE_API_KEY', () => {
    expect(loadScrapingBeeEnv({ SCRAPINGBEE_API_KEY: 'sb-live-key' }).apiKey).toBe('sb-live-key');
  });

  it('rejects a missing or empty key', () => {
    expect(() => loadScrapingBeeEnv({})).toThrow(ScrapingBeeCredentialsError);
    expect(() => loadScrapingBeeEnv({ SCRAPINGBEE_API_KEY: '' })).toThrow(
      ScrapingBeeCredentialsError,
    );
  });

  it('rejects the YOUR_API_KEY placeholder', () => {
    expect(() => loadScrapingBeeEnv({ SCRAPINGBEE_API_KEY: 'YOUR_API_KEY' })).toThrow(
      ScrapingBeeCredentialsError,
    );
  });
});

describe('loadDefaultConfig', () => {
  it('defaults to multilingual-002 and hypothesis seed version', () => {
    const config = loadDefaultConfig();
    expect(config.layer2.embedding_model).toBe('text-multilingual-embedding-002');
    expect(config.seed_version).toBe('v0_hypothesis');
    expect(config.layer2.cosine_distance_threshold).toBe(0.28);
  });
});
