import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Loads public/share-target-sw.js against a stub worker scope and hands it one POST.
async function share(init: { referrer?: string; site?: string }): Promise<{ stored: string[]; location: string | null }> {
  const stored: string[] = [];
  let handler: ((event: unknown) => void) | null = null;
  const scope = { addEventListener: (_type: string, fn: (event: unknown) => void) => (handler = fn) };
  const caches = { open: async () => ({ put: async (key: string) => void stored.push(key) }) };
  const source = readFileSync(join(__dirname, '../../public/share-target-sw.js'), 'utf8');
  // Node's Response.redirect wants an absolute URL; a worker resolves a relative one.
  const FakeResponse = class {
    static redirect(location: string) {
      return { headers: new Headers({ location }) };
    }
  };
  new Function('self', 'caches', 'Response', source)(scope, caches, FakeResponse);
  const form = new FormData();
  form.append('file', new File(['x'], 'planted.txt'));
  const headers = new Headers(init.site ? { 'sec-fetch-site': init.site } : {});
  const request = { url: 'https://perch.example/share-target', method: 'POST', referrer: init.referrer ?? '', headers, formData: async () => form };
  let response: Promise<{ headers: Headers }> | { headers: Headers } | null = null;
  handler!({ request, respondWith: (r: Promise<{ headers: Headers }>) => (response = r) });
  const res = await response!;
  return { stored, location: res.headers.get('location') };
}

describe('share-target-sw.js', () => {
  it('stashes a share the OS started: no referrer', async () => {
    expect(await share({})).toEqual({ stored: ['/shared-file'], location: expect.stringContaining('/?shared=1') });
    expect((await share({ site: 'none' })).stored).toEqual(['/shared-file']);
  });

  it('drops a POST another site sent', async () => {
    expect(await share({ referrer: 'https://evil.example/page' })).toEqual({ stored: [], location: expect.not.stringContaining('shared') });
    expect((await share({ site: 'cross-site' })).stored).toEqual([]);
  });
});
