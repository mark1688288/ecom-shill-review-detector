// SPDX-License-Identifier: GPL-3.0-only
import { Storage } from '@google-cloud/storage';

export type ParsedGcsUri = {
  bucket: string;
  object?: string;
};

export function stripGsPrefix(value: string): string {
  return value.replace(/^gs:\/\//, '');
}

export function parseGcsUri(uri: string): ParsedGcsUri {
  const withoutScheme = stripGsPrefix(uri).replace(/^\/+/, '');
  if (withoutScheme.length === 0) {
    throw new Error('GCS URI is empty');
  }
  const slash = withoutScheme.indexOf('/');
  if (slash === -1) {
    return { bucket: withoutScheme };
  }
  const bucket = withoutScheme.slice(0, slash);
  const object = withoutScheme.slice(slash + 1);
  if (bucket.length === 0) {
    throw new Error(`invalid GCS URI: ${uri}`);
  }
  if (object.length === 0) {
    return { bucket };
  }
  return { bucket, object };
}

export type ResolveStagingGcsUriInput = {
  crawlBatchId: string;
  project: string;
  gcsUri?: string;
  stagingBucket?: string;
};

export function resolveStagingGcsUri(input: ResolveStagingGcsUriInput): string {
  const objectFallback = `${input.crawlBatchId}/reviews.ndjson`;
  if (input.gcsUri !== undefined && input.gcsUri.length > 0) {
    const parsed = parseGcsUri(input.gcsUri);
    if (parsed.object !== undefined) {
      return `gs://${parsed.bucket}/${parsed.object}`;
    }
    return `gs://${parsed.bucket}/${objectFallback}`;
  }
  const fromEnv = input.stagingBucket;
  const bucketRaw =
    fromEnv !== undefined && fromEnv.length > 0
      ? fromEnv
      : `${input.project}-ecom-shill-staging`;
  const bucket = stripGsPrefix(bucketRaw);
  if (bucket.length === 0) {
    throw new Error('GCS staging bucket is empty');
  }
  return `gs://${bucket}/${objectFallback}`;
}

export type UploadNdjsonOptions = {
  contents: string;
  gcsUri: string;
  project: string;
  storage?: Storage;
};

export async function uploadNdjsonToGcs(opts: UploadNdjsonOptions): Promise<string> {
  const parsed = parseGcsUri(opts.gcsUri);
  if (parsed.object === undefined) {
    throw new Error(`GCS URI must include an object path: ${opts.gcsUri}`);
  }
  const storage = opts.storage ?? new Storage({ projectId: opts.project });
  await storage.bucket(parsed.bucket).file(parsed.object).save(opts.contents, {
    resumable: false,
    contentType: 'application/x-ndjson',
  });
  return `gs://${parsed.bucket}/${parsed.object}`;
}
