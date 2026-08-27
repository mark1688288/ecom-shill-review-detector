// SPDX-License-Identifier: GPL-3.0-only
import pino, { type Logger } from 'pino';

export function createLogger(level = process.env['LOG_LEVEL'] ?? 'info'): Logger {
  return pino({
    level,
    base: null,
  });
}

let singleton: Logger | undefined;

export function getLogger(): Logger {
  singleton ??= createLogger();
  return singleton;
}
