import { describe, expect, it } from 'vitest';
import { CONTENT_SECURITY_POLICY } from './csp';
import { SCRIBE_ENDPOINT } from '../adapters/elevenlabs-transcriber';

function directive(name: string): string[] {
  const found = CONTENT_SECURITY_POLICY.split(';').map((d) => d.trim().split(/\s+/)).find(([n]) => n === name);
  if (!found) throw new Error(`no ${name}`);
  return found.slice(1);
}

describe('CONTENT_SECURITY_POLICY', () => {
  it('runs no script but the bundle: no inline, eval or blob script', () => {
    expect(directive('script-src')).toEqual(["'self'"]);
    expect(directive('object-src')).toEqual(["'none'"]);
  });

  // Relays live on any host, and dictation calls ElevenLabs straight from the browser.
  it('lets the app reach any relay and the speech-to-text API', () => {
    expect(directive('connect-src')).toEqual(expect.arrayContaining(['https:', 'wss:']));
    expect(new URL(SCRIBE_ENDPOINT).protocol).toBe('https:');
  });

  it('keeps blob previews working: PDF frame, images, audio', () => {
    expect(directive('frame-src')).toContain('blob:');
    expect(directive('img-src')).toContain('blob:');
    expect(directive('media-src')).toContain('blob:');
  });

  it('loads no remote image', () => {
    expect(directive('img-src')).not.toContain('https:');
  });
});
