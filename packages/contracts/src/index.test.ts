import { describe, it, expect } from 'vitest';
import {
  parseBrowserClientMessage,
  parseBrowserAgentMessage,
} from './index';

describe('@tarfa/contracts', () => {
  it('exports the browser stream message parsers', () => {
    expect(typeof parseBrowserClientMessage).toBe('function');
    expect(typeof parseBrowserAgentMessage).toBe('function');
  });
});
