import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// wrangler.jsonc with its whole-line comments dropped (it has no trailing ones).
const config = JSON.parse(
  readFileSync(join(__dirname, '../wrangler.jsonc'), 'utf8')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n'),
) as Record<string, any>;

describe('wrangler.jsonc', () => {
  it('serves tarfa.app from env.production alone, with no workers.dev host or preview URLs', () => {
    expect(config.env.production).toMatchObject({
      name: 'tarfa',
      routes: [{ pattern: 'tarfa.app', custom_domain: true }],
      workers_dev: false,
      preview_urls: false,
    });
  });

  it('keeps the top level a Worker of its own, which a bare deploy could not make production', () => {
    expect(config.name).not.toBe('tarfa');
    expect(config.routes).toBeUndefined();
    expect(config.workers_dev).toBe(false);
  });

  it('gives the dev Worker its own name, on workers.dev', () => {
    expect(config.env.dev).toMatchObject({ name: 'tarfa-dev', workers_dev: true });
  });

  it('serves the built app', () => {
    expect(config.assets.directory).toBe('./dist');
  });
});
