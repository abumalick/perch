import { describe, expect, it } from 'vitest';
import { describeError } from './describe-error';

describe('describeError', () => {
  it('names a DOMException by its name and message, which is what tells browser failures apart', () => {
    expect(describeError(new DOMException('The object can not be cloned.', 'DataCloneError'))).toBe(
      'DataCloneError: The object can not be cloned.',
    );
  });

  it('keeps a plain Error to its message', () => {
    expect(describeError(new Error('IndexedDB unavailable'))).toBe('IndexedDB unavailable');
  });

  it('shows a TypeError by name', () => {
    expect(describeError(new TypeError('x is undefined'))).toBe('TypeError: x is undefined');
  });

  it('shows a name alone when there is no message', () => {
    expect(describeError(new DOMException('', 'UnknownError'))).toBe('UnknownError');
  });

  it('stringifies anything else that was thrown', () => {
    expect(describeError('boom')).toBe('boom');
    expect(describeError(null)).toBe('unknown error');
  });
});
