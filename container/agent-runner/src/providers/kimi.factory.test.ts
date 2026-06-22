import { describe, it, expect } from 'bun:test';

import { KimiProvider } from './kimi.js';
import { createProvider } from './factory.js';
import {
  buildMcpConfig,
  classifyError,
  interpretKimiObject,
  LineBuffer,
  parseClaudeImports,
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

describe('interpretKimiObject (CLI 0.19.0 role-based schema)', () => {
  it('extracts the session id from the meta resume_hint line', () => {
    const sig = interpretKimiObject({
      role: 'meta',
      type: 'session.resume_hint',
      session_id: 'session_2d952f70-1178-413b-aba3-2275f2aa472a',
      command: 'kimi -r session_2d952f70-1178-413b-aba3-2275f2aa472a',
    });
    expect(sig.sessionId).toBe('session_2d952f70-1178-413b-aba3-2275f2aa472a');
    expect(sig.final).toBeUndefined();
  });

  it('reads the answer from an assistant content message', () => {
    expect(interpretKimiObject({ role: 'assistant', content: 'pong' }).final).toBe('pong');
  });

  it('joins array content blocks', () => {
    const sig = interpretKimiObject({
      role: 'assistant',
      content: ['hello ', { text: 'world' }, { type: 'image' }],
    });
    expect(sig.final).toBe('hello world');
  });

  it('treats a tool-call assistant message as liveness only (no answer)', () => {
    const sig = interpretKimiObject({
      role: 'assistant',
      tool_calls: [{ type: 'function', id: 'tool_1', function: { name: 'Bash', arguments: '{}' } }],
    });
    expect(sig.final).toBeUndefined();
  });

  it('does not mistake tool output for the answer', () => {
    expect(interpretKimiObject({ role: 'tool', tool_call_id: 'tool_1', content: 'KIMI_TOOL_OK\n' }).final).toBeUndefined();
  });

  it('captures an error line', () => {
    expect(interpretKimiObject({ role: 'error', error: 'boom' }).errorMessage).toBe('boom');
  });

  it('returns an empty signal for unrecognized lines', () => {
    expect(interpretKimiObject({ role: 'user', content: 'hi' })).toEqual({});
    expect(interpretKimiObject(null)).toEqual({});
    expect(interpretKimiObject(safeParseJson('not json'))).toEqual({});
  });
});

describe('parsing a captured stream-json transcript', () => {
  it('yields the final answer and session id from a real tool-using turn', () => {
    const transcript = [
      '{"role":"assistant","tool_calls":[{"type":"function","id":"tool_KP","function":{"name":"Bash","arguments":"{\\"command\\":\\"echo KIMI_TOOL_OK\\"}"}}]}',
      '{"role":"tool","tool_call_id":"tool_KP","content":"KIMI_TOOL_OK\\n"}',
      '{"role":"assistant","content":"KIMI_TOOL_OK"}',
      '{"role":"meta","type":"session.resume_hint","session_id":"session_310e063e","command":"kimi -r session_310e063e"}',
    ];
    const lb = new LineBuffer();
    let final: string | null | undefined;
    let sessionId: string | undefined;
    for (const line of lb.push(transcript.join('\n') + '\n')) {
      const sig = interpretKimiObject(safeParseJson(line));
      if (sig.sessionId) sessionId = sig.sessionId;
      if (sig.final !== undefined) final = sig.final;
    }
    expect(final).toBe('KIMI_TOOL_OK');
    expect(sessionId).toBe('session_310e063e');
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

describe('parseClaudeImports', () => {
  it('extracts @./ import paths from a composed CLAUDE.md index', () => {
    const body = [
      '<!-- Composed at spawn — do not edit. -->',
      '@./.claude-shared.md',
      '@./.claude-fragments/module-core.md',
      '@./.claude-fragments/skill-onecli-gateway.md',
      'some inline note',
    ].join('\n');
    expect(parseClaudeImports(body)).toEqual([
      './.claude-shared.md',
      './.claude-fragments/module-core.md',
      './.claude-fragments/skill-onecli-gateway.md',
    ]);
  });

  it('returns nothing for a flat CLAUDE.md with no imports', () => {
    expect(parseClaudeImports('# Just instructions\nno imports here')).toEqual([]);
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
