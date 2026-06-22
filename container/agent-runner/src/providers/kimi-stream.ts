/**
 * Pure parsing helpers for the Kimi Code CLI's `--output-format stream-json`
 * output. Kept free of any I/O so they can be unit-tested without spawning the
 * CLI.
 *
 * Kimi's `kimi -p ... --output-format stream-json` emits newline-delimited,
 * role-tagged JSON objects (verified against CLI 0.19.0):
 *   {"role":"assistant","content":"<answer text>"}
 *   {"role":"assistant","tool_calls":[{"type":"function","function":{"name",...}}]}
 *   {"role":"tool","tool_call_id":"...","content":"<tool output>"}
 *   {"role":"meta","type":"session.resume_hint","session_id":"session_<uuid>",...}
 * There is no terminal `result` event — the LAST content-bearing assistant
 * message is the answer. The extraction below degrades gracefully: anything it
 * doesn't recognize yields an empty signal (the caller still counts the line as
 * liveness activity). Refine `interpretKimiObject` against captured output if a
 * future Kimi release changes the shape.
 */

/** Continuation token stored when the stream never exposed a real session id. */
export const RESUME_SENTINEL = 'kimi:resume';

/**
 * Errors whose text means the stored continuation is no longer resumable, so
 * the poll-loop should drop it and start a fresh session.
 */
export const STALE_SESSION_RE =
  /session\s+not\s+found|unknown\s+session|no\s+such\s+session|invalid\s+session|conversation\s+not\s+found|no\s+conversation|session.*expired|ENOENT|no (previous|recent) session/i;

/** Normalized signals extracted from one stream-json line. */
export interface KimiSignal {
  /** A session/conversation id, if this line carried one. */
  sessionId?: string;
  /** Incremental assistant text to accumulate into the running result. */
  delta?: string;
  /** Final result text (present once, on the terminal `result` event). */
  final?: string | null;
  /** The terminal `result` event reported an error. */
  finalIsError?: boolean;
  /** An error message surfaced by an `error` event or an error result. */
  errorMessage?: string;
}

/** Accumulates stdout chunks and yields complete, non-empty lines. */
export class LineBuffer {
  private buf = '';

  push(chunk: string): string[] {
    this.buf += chunk;
    const lines: string[] = [];
    let idx: number;
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, idx).replace(/\r$/, '');
      this.buf = this.buf.slice(idx + 1);
      if (line.trim()) lines.push(line);
    }
    return lines;
  }

  /** Return any buffered trailing partial line (no newline seen), then clear. */
  flush(): string | null {
    const rest = this.buf.trim();
    this.buf = '';
    return rest || null;
  }
}

export function safeParseJson(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

/** Text from an assistant `content` field, which may be a plain string or an
 * array of rich blocks. */
function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string') {
          return (part as { text: string }).text;
        }
        return '';
      })
      .join('');
  }
  return '';
}

/** Best-effort error string from an arbitrary error-shaped object. */
function stringifyError(obj: Record<string, unknown>): string {
  const err = obj.error ?? obj.message ?? obj.result;
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object') {
    const m = (err as { message?: unknown }).message;
    if (typeof m === 'string') return m;
  }
  return 'kimi reported an error';
}

export function interpretKimiObject(obj: unknown): KimiSignal {
  const sig: KimiSignal = {};
  if (!obj || typeof obj !== 'object') return sig;
  const o = obj as Record<string, unknown>;

  // Session id rides on the meta `session.resume_hint` line.
  const sid = o.session_id ?? o.sessionId ?? o.session;
  if (typeof sid === 'string' && sid) sig.sessionId = sid;

  // Error lines (exact shape undocumented — match defensively).
  if (o.role === 'error' || o.type === 'error' || o.error) {
    sig.errorMessage = stringifyError(o);
    return sig;
  }

  // Only assistant messages carry answer text. A content-bearing assistant
  // message is an answer; since there's no terminal result event, expose it as
  // the (overwritable) final — the last one wins. Tool-call-only assistant
  // messages and `tool`/`meta`/`user` lines contribute liveness only.
  if (o.role === 'assistant') {
    const text = extractText(o.content);
    if (text) sig.final = text;
  }

  return sig;
}

export function classifyError(message: string): string | undefined {
  if (/auth|api key|unauthorized|401|forbidden|403|login|credential/i.test(message)) return 'auth';
  if (/quota|rate limit|429|insufficient|billing|credit|payment/i.test(message)) return 'quota';
  if (/session|conversation|thread/i.test(message)) return 'stale-session';
  return undefined;
}

/** A stdio MCP server entry as Kimi's `mcp.json` expects it. */
export interface KimiMcpServer {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

interface McpServerInput {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/**
 * Build the contents of Kimi's `mcp.json` from the runner's MCP server map.
 * Merges NanoClaw's servers over any `existing` file content (preserving
 * operator-added servers and other top-level keys). Returns `null` when there's
 * nothing to write, so the caller leaves any existing file untouched.
 */
export function buildMcpConfig(
  servers: Record<string, McpServerInput> | undefined,
  existing?: unknown,
): Record<string, unknown> | null {
  const existingObj =
    existing && typeof existing === 'object' && !Array.isArray(existing)
      ? (existing as Record<string, unknown>)
      : {};
  const existingServers =
    existingObj.mcpServers && typeof existingObj.mcpServers === 'object'
      ? (existingObj.mcpServers as Record<string, KimiMcpServer>)
      : {};

  const merged: Record<string, KimiMcpServer> = { ...existingServers };
  for (const [name, cfg] of Object.entries(servers ?? {})) {
    if (!cfg?.command) continue;
    merged[name] = {
      command: cfg.command,
      args: cfg.args ?? [],
      ...(cfg.env && Object.keys(cfg.env).length ? { env: cfg.env } : {}),
    };
  }

  if (Object.keys(merged).length === 0) return null;
  return { ...existingObj, mcpServers: merged };
}
