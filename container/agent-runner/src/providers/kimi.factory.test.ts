import { describe, it, expect } from 'bun:test';

import { KimiProvider } from './kimi.js';
import { createProvider } from './factory.js';
import {
  buildMcpConfig,
  classifyError,
  interpretKimiObject,
  LineBuffer,
  RESUME_SENTINEL,
  safeParseJson,
  STALE_SESSION_RE,
} from './kimi-stream.js';

describe('createProvider', () => {
  it('returns KimiProvider for kimi', () => {
    expect(createProvider('kimi')).toBeInstanceOf(KimiProvider);
  });
});

describe('KimiProvider.isSessionInvalid', () => {
  const provider = new KimiProvider();

  it('flags stale-session errors', () => {
    expect(provider.isSessionInvalid(new Error('session not found'))).toBe(true);
    expect(provider.isSessionInvalid(new Error('no conversation found'))).toBe(true);
    expect(provider.isSessionInvalid('Error: unknown session abc')).toBe(true);
  });

  it('ignores unrelated errors', () => {
    expect(provider.isSessionInvalid(new Error('rate limit exceeded'))).toBe(false);
    expect(provider.isSessionInvalid(new Error('hello'))).toBe(false);
  });
});

describe('LineBuffer', () => {
  it('splits complete newline-delimited lines and skips blanks', () => {
    const lb = new LineBuffer();
    expect(lb.push('{"a":1}\n{"b":2}\n\n')).toEqual(['{"a":1}', '{"b":2}']);
  });

  it('holds a partial line until its newline arrives, then flushes the tail', () => {
    const lb = new LineBuffer();
    expect(lb.push('{"a"')).toEqual([]);
    expect(lb.push(':1}\n{"c":3}')).toEqual(['{"a":1}']);
    expect(lb.flush()).toBe('{"c":3}');
  });
});

describe('interpretKimiObject', () => {
  it('extracts the session id from a system init event', () => {
    const sig = interpretKimiObject({ type: 'system', subtype: 'init', session_id: 'sess_123' });
    expect(sig.sessionId).toBe('sess_123');
  });

  it('accumulates assistant message text as a delta', () => {
    const sig = interpretKimiObject({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'hello ' }, { type: 'tool_use' }, { type: 'text', text: 'world' }] },
    });
    expect(sig.delta).toBe('hello world');
  });

  it('captures the terminal result text', () => {
    const sig = interpretKimiObject({
      type: 'result',
      subtype: 'success',
      result: 'final answer',
      session_id: 'sess_123',
      is_error: false,
    });
    expect(sig.final).toBe('final answer');
    expect(sig.finalIsError).toBeUndefined();
    expect(sig.sessionId).toBe('sess_123');
  });

  it('marks an errored result', () => {
    const sig = interpretKimiObject({ type: 'result', subtype: 'error_max_turns', result: 'boom', is_error: true });
    expect(sig.finalIsError).toBe(true);
    expect(sig.errorMessage).toBe('boom');
  });

  it('returns an empty signal for unrecognized lines', () => {
    expect(interpretKimiObject({ type: 'user' })).toEqual({});
    expect(interpretKimiObject(null)).toEqual({});
    expect(interpretKimiObject(safeParseJson('not json'))).toEqual({});
  });
});

describe('buildMcpConfig', () => {
  it('maps runner servers into Kimi mcp.json shape', () => {
    const config = buildMcpConfig({
      ncl: { command: 'bun', args: ['/app/src/cli/ncl.ts'], env: {} },
      fetch: { command: 'npx', args: ['-y', 'mcp-fetch'], env: { TOKEN: 'x' } },
    });
    expect(config).toEqual({
      mcpServers: {
        ncl: { command: 'bun', args: ['/app/src/cli/ncl.ts'] },
        fetch: { command: 'npx', args: ['-y', 'mcp-fetch'], env: { TOKEN: 'x' } },
      },
    });
  });

  it('merges over existing file content, preserving operator servers and top-level keys', () => {
    const config = buildMcpConfig(
      { ncl: { command: 'bun', args: [] } },
      { version: 1, mcpServers: { custom: { command: 'mine', args: [] } } },
    );
    expect(config).toEqual({
      version: 1,
      mcpServers: {
        custom: { command: 'mine', args: [] },
        ncl: { command: 'bun', args: [] },
      },
    });
  });

  it('returns null when there is nothing to write', () => {
    expect(buildMcpConfig({})).toBeNull();
    expect(buildMcpConfig(undefined, { mcpServers: {} })).toBeNull();
  });
});

describe('classifyError / STALE_SESSION_RE', () => {
  it('classifies common failure modes', () => {
    expect(classifyError('401 unauthorized: bad api key')).toBe('auth');
    expect(classifyError('429 rate limit exceeded')).toBe('quota');
    expect(classifyError('session not found')).toBe('stale-session');
    expect(classifyError('disk full')).toBeUndefined();
  });

  it('exposes a non-empty resume sentinel distinct from real ids', () => {
    expect(RESUME_SENTINEL).toBeTruthy();
    expect(STALE_SESSION_RE.test('conversation not found')).toBe(true);
  });
});
