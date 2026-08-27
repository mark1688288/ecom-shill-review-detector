// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest';
import { parseGcsUri, resolveStagingGcsUri, stripGsPrefix } from '../../src/crawler/persist/gcs.js';

const BATCH = '11111111-1111-4111-8111-111111111111';

describe('parseGcsUri', () => {
  it('accepts a bucket with or without gs://', () => {
    expect(parseGcsUri('gs://my-bucket')).toEqual({ bucket: 'my-bucket' });
    expect(parseGcsUri('my-bucket')).toEqual({ bucket: 'my-bucket' });
  });

  it('parses a full object URI', () => {
    expect(parseGcsUri(`gs://my-bucket/${BATCH}/reviews.ndjson`)).toEqual({
      bucket: 'my-bucket',
      object: `${BATCH}/reviews.ndjson`,
    });
  });
});

describe('resolveStagingGcsUri', () => {
  it('uses a full --gcs-uri object path when provided', () => {
    expect(
      resolveStagingGcsUri({
        crawlBatchId: BATCH,
        project: 'demo-project',
        gcsUri: 'gs://custom/path/file.ndjson',
      }),
    ).toBe('gs://custom/path/file.ndjson');
  });

  it('appends crawl_batch_id when --gcs-uri is only a bucket', () => {
    expect(
      resolveStagingGcsUri({
        crawlBatchId: BATCH,
        project: 'demo-project',
        gcsUri: 'gs://custom-bucket',
      }),
    ).toBe(`gs://custom-bucket/${BATCH}/reviews.ndjson`);
  });

  it('falls back to {project}-ecom-shill-staging and includes crawl_batch_id', () => {
    expect(
      resolveStagingGcsUri({
        crawlBatchId: BATCH,
        project: 'demo-project',
      }),
    ).toBe(`gs://demo-project-ecom-shill-staging/${BATCH}/reviews.ndjson`);
  });

  it('strips gs:// from GCS_STAGING_BUCKET', () => {
    expect(stripGsPrefix('gs://env-bucket')).toBe('env-bucket');
    expect(
      resolveStagingGcsUri({
        crawlBatchId: BATCH,
        project: 'demo-project',
        stagingBucket: 'gs://env-bucket',
      }),
    ).toBe(`gs://env-bucket/${BATCH}/reviews.ndjson`);
  });
});
