// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest';
import { sqlParamOrNull } from '../../src/shared/bq.js';

describe('sqlParamOrNull', () => {
  it('omits null/undefined params and emits a typed CAST NULL', () => {
    const params: Record<string, unknown> = { keep: 1 };
    expect(sqlParamOrNull(params, 'finished_at', null, 'TIMESTAMP')).toBe(
      'CAST(NULL AS TIMESTAMP)',
    );
    expect(sqlParamOrNull(params, 'rows_out', undefined, 'INT64')).toBe('CAST(NULL AS INT64)');
    expect(sqlParamOrNull(params, 'error_message', null, 'STRING')).toBe('CAST(NULL AS STRING)');
    expect(params).toEqual({ keep: 1 });
  });

  it('binds present values as named params', () => {
    const params: Record<string, unknown> = {};
    expect(sqlParamOrNull(params, 'rows_in', 8, 'INT64')).toBe('@rows_in');
    expect(sqlParamOrNull(params, 'error_message', 'boom', 'STRING')).toBe('@error_message');
    expect(params).toEqual({ rows_in: 8, error_message: 'boom' });
  });
});
