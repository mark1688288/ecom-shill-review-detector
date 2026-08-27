// SPDX-License-Identifier: GPL-3.0-only
import type { MarketplaceAdapter, MarketplaceId } from '../adapter.js';
import { FixtureAdapter } from './fixture.js';
import { JsonApiAdapter } from './json-api.js';

export { FixtureAdapter } from './fixture.js';
export { JsonApiAdapter, marketplaceConfigPath } from './json-api.js';

export function createAdapter(
  id: MarketplaceId,
  salt: string,
  jsonApiConfigDir?: string,
): MarketplaceAdapter {
  switch (id) {
    case 'fixture':
      return new FixtureAdapter(salt);
    case 'json_api':
      return jsonApiConfigDir === undefined
        ? new JsonApiAdapter()
        : new JsonApiAdapter(jsonApiConfigDir);
    default: {
      const _never: never = id;
      throw new Error(`unknown adapter: ${String(_never)}`);
    }
  }
}
