/**
 * Pure parsing helpers for the Kimi Code CLI's `--output-format stream-json`
 * output. Kept free of any I/O so they can be unit-tested without spawning the
 * CLI.
 *
 * Kimi's `kimi -p ... --output-format stream-json` mirrors Claude Code's flags,
 * and in practice emits the same newline-delimited JSON shapes:
 *   {"type":"system","subtype":"init","session_id":"..."}
 *   {"type":"assistant","message":{"content":[{"type":"text","text":"..."}]}}
 *   {"type":"result","subtype":"success","result":"...","session_id":"...","is_error":false}
 * The extraction below targets that schema but degrades gracefully: anything it
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

function extractAssistantText(message: unknown): string {
  if (!message || typeof message !== 'object') return '';
  const content = (message as { content?: unknown }).content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(
        (part): part is { type: string; text: string } =>
          !!part &&
          typeof part === 'object' &&
          (part as { type?: unknown }).type === 'text' &&
          typeof (part as { text?: unknown }).text === 'string',
      )
      .map((part) => part.text)
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

  const sid = o.session_id ?? o.sessionId ?? o.session;
  if (typeof sid === 'string' && sid) sig.sessionId = sid;

  switch (o.type) {
    case 'assistant': {
      const text = extractAssistantText(o.message ?? o);
      if (text) sig.delta = text;
      break;
    }
    case 'result': {
      sig.final = typeof o.result === 'string' ? o.result : null;
      const errored =
        o.is_error === true ||
        (typeof o.subtype === 'string' && /error/i.test(o.subtype));
      if (errored) {
        sig.finalIsError = true;
        sig.errorMessage = typeof o.result === 'string' ? o.result : stringifyError(o);
      }
      break;
    }
    case 'error': {
      sig.errorMessage = stringifyError(o);
      break;
    }
    default: {
      // Streaming-delta fallbacks for other CLI shapes.
      const delta = o.delta;
      if (delta && typeof delta === 'object' && typeof (delta as { text?: unknown }).text === 'string') {
        sig.delta = (delta as { text: string }).text;
      } else if (
        typeof o.text === 'string' &&
        (o.type === 'text' || o.type === 'content_block_delta')
      ) {
        sig.delta = o.text;
      }
      break;
    }
  }
  return sig;
}

export function classifyError(message: string): string | undefined {
  if (/auth|api key|unauthorized|401|forbidden|403|login|credential/i.test(message)) return 'auth';
  if (/quota|rate limit|429|insufficient|billing|credit|payment/i.test(message)) return 'quota';
  if (/session|conversation|thread/i.test(message)) return 'stale-session';
  return undefined;
}
