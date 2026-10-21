import { describe, it, expect } from 'vitest';
import { parseAgentMessage, parseClientMessage } from './messages';

const event = { sess: 's', seq: 0, t: 1, kind: 'online', online: true, vis: 'visible' };

describe('session channels on the wire', () => {
  it('keeps what authenticated the session and whether the device key is enrolled', () => {
    expect(parseAgentMessage({ type: 'authResult', ok: true, credential: 'token', enrolled: true })).toEqual({
      type: 'authResult',
      ok: true,
      credential: 'token',
      enrolled: true,
    });
    // A value a newer agent might send is dropped, not the whole message.
    expect(parseAgentMessage({ type: 'authResult', ok: true, credential: 'passkey' })).toEqual({ type: 'authResult', ok: true });
  });

  it('drops the channel list an older agent still advertises on authResult', () => {
    expect(parseAgentMessage({ type: 'authResult', ok: true, channels: ['media', 'browser'] })).toEqual({ type: 'authResult', ok: true });
  });

  it('parses the media request, acknowledgement and cancel', () => {
    expect(parseClientMessage({ type: 'readMedia', id: 'm1', path: '/p/a.png' })).toEqual({
      type: 'readMedia',
      id: 'm1',
      path: '/p/a.png',
    });
    expect(parseClientMessage({ type: 'mediaAck', id: 'm1', seq: 3 })).toEqual({ type: 'mediaAck', id: 'm1', seq: 3 });
    expect(parseClientMessage({ type: 'mediaCancel', id: 'm1' })).toEqual({ type: 'mediaCancel', id: 'm1' });
  });

  it('parses the media header and chunks', () => {
    expect(parseAgentMessage({ type: 'media', id: 'm1', result: 'ok', mediaType: 'image/png', size: 10 })).toEqual({
      type: 'media',
      id: 'm1',
      result: 'ok',
      mediaType: 'image/png',
      size: 10,
    });
    expect(parseAgentMessage({ type: 'media', id: 'm1', result: 'too-large' })).toEqual({
      type: 'media',
      id: 'm1',
      result: 'too-large',
    });
    expect(parseAgentMessage({ type: 'mediaChunk', id: 'm1', seq: 0, data: 'AAAA' })).toEqual({
      type: 'mediaChunk',
      id: 'm1',
      seq: 0,
      data: 'AAAA',
    });
  });

  it('rejects an unknown media result and an unbounded id', () => {
    expect(() => parseAgentMessage({ type: 'media', id: 'm1', result: 'maybe' })).toThrow();
    expect(() => parseClientMessage({ type: 'readMedia', id: 'x'.repeat(65), path: '/a.png' })).toThrow();
  });

  it('parses the browser stream envelope both ways', () => {
    expect(parseClientMessage({ type: 'browserOpen', stream: 'b1', session: 'perch-demo' })).toEqual({
      type: 'browserOpen',
      stream: 'b1',
      session: 'perch-demo',
    });
    expect(parseClientMessage({ type: 'browser', stream: 'b1', data: '{"type":"ping"}' })).toEqual({
      type: 'browser',
      stream: 'b1',
      data: '{"type":"ping"}',
    });
    expect(parseClientMessage({ type: 'browserAck', stream: 'b1' })).toEqual({ type: 'browserAck', stream: 'b1' });
    expect(parseClientMessage({ type: 'browserClose', stream: 'b1' })).toEqual({ type: 'browserClose', stream: 'b1' });
    expect(parseAgentMessage({ type: 'browser', stream: 'b1', data: '{}' })).toEqual({ type: 'browser', stream: 'b1', data: '{}' });
    expect(parseAgentMessage({ type: 'browserClosed', stream: 'b1' })).toEqual({ type: 'browserClosed', stream: 'b1' });
  });

  it('parses a client-log batch and its acknowledgement', () => {
    expect(parseClientMessage({ type: 'clientLog', id: 'l1', batch: { events: [event] } })).toEqual({
      type: 'clientLog',
      id: 'l1',
      batch: { events: [event] },
    });
    expect(parseAgentMessage({ type: 'clientLogAck', id: 'l1', ok: true })).toEqual({ type: 'clientLogAck', id: 'l1', ok: true });
    expect(() => parseClientMessage({ type: 'clientLog', id: 'l1', batch: { events: [] } })).toThrow();
  });
});
