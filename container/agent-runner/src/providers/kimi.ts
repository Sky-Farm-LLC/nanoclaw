/**
 * Kimi Code CLI provider.
 *
 * Drives Moonshot AI's `kimi` CLI (npm: `@moonshot-ai/kimi-code`) in headless
 * mode, one subprocess per turn:
 *
 *   kimi -p "<prompt>" --output-format stream-json --yolo [--session <id> | --continue]
 *
 * `--yolo` auto-approves tool calls (NanoClaw's container isolation + OneCLI
 * allow-list are the security boundary). stream-json gives us line-by-line
 * liveness — every stdout line is reported as an `activity` event so the
 * poll-loop's idle timer stays honest during long tool runs, the failure mode
 * that buffered text output would cause.
 *
 * Continuation: Kimi keeps conversation state in its config home
 * (`KIMI_CODE_HOME`), which the host mounts per session — so resuming is safe.
 * We store the real session id when the stream exposes one and resume with
 * `--session <id>`; otherwise we store a sentinel and resume with `--continue`
 * (most-recent session in this per-session mount).
 *
 * Auth is file-based (the host seeds `~/.kimi-code` into the mount); no API key
 * is passed through env. See `src/providers/kimi.ts` on the host side.
 */
import { spawn, type ChildProcess } from 'child_process';

import { registerProvider } from './provider-registry.js';
import type {
  AgentProvider,
  AgentQuery,
  ProviderEvent,
  ProviderOptions,
  QueryInput,
} from './types.js';
import {
  classifyError,
  interpretKimiObject,
  LineBuffer,
  RESUME_SENTINEL,
  safeParseJson,
  STALE_SESSION_RE,
} from './kimi-stream.js';

const TURN_TIMEOUT_MS = Number(process.env.KIMI_IDLE_TIMEOUT_MS) || 10 * 60 * 1000;

function killProcess(proc: ChildProcess): void {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  try {
    proc.kill('SIGKILL');
  } catch {
    /* already gone */
  }
}

/** First turn carries the system instructions; resumed turns rely on Kimi's
 * own retained session context. */
function buildFirstPrompt(prompt: string, instructions: string | undefined): string {
  if (!instructions?.trim()) return prompt;
  return `${instructions}\n\n---\n\n${prompt}`;
}

export class KimiProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = false;

  // Kept for parity with other providers; Kimi's stable `kimi-for-coding` alias
  // auto-selects the backend model, so we don't pass a model flag in v1.
  private readonly model?: string;
  private readonly bin: string;

  constructor(options: ProviderOptions = {}) {
    this.model = options.model;
    this.bin = process.env.KIMI_BIN || 'kimi';
  }

  isSessionInvalid(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return STALE_SESSION_RE.test(msg);
  }

  query(input: QueryInput): AgentQuery {
    const bin = this.bin;
    const cwd = input.cwd;
    const instructions = input.systemContext?.instructions;

    const pending: string[] = [
      buildFirstPrompt(input.prompt, input.continuation ? undefined : instructions),
    ];
    let waiting: (() => void) | null = null;
    let ended = false;
    let aborted = false;
    let initYielded = false;
    let sessionId: string | undefined = input.continuation;
    let activeProc: ChildProcess | null = null;

    const wake = (): void => {
      const w = waiting;
      waiting = null;
      w?.();
    };

    const resumeArgs = (): string[] => {
      if (!sessionId) return [];
      if (sessionId === RESUME_SENTINEL) return ['--continue'];
      return ['--session', sessionId];
    };

    async function* runTurn(text: string): AsyncGenerator<ProviderEvent> {
      const args = ['-p', text, '--output-format', 'stream-json', '--yolo', ...resumeArgs()];
      const proc = spawn(bin, args, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
      activeProc = proc;

      const buffer: ProviderEvent[] = [];
      let waker: (() => void) | null = null;
      const kick = (): void => {
        const w = waker;
        waker = null;
        w?.();
      };

      let done = false;
      // Boxed so assignments inside the stdout/close callbacks aren't lost to
      // control-flow narrowing (a closure-assigned `let` reads back as `never`).
      const turn: { error: Error | null } = { error: null };
      let resultText = '';
      let finalText: string | null | undefined;
      let stderrTail = '';
      const lb = new LineBuffer();

      const onLine = (line: string): void => {
        buffer.push({ type: 'activity' });
        const sig = interpretKimiObject(safeParseJson(line));
        if (sig.sessionId) {
          sessionId = sig.sessionId;
          if (!initYielded) {
            initYielded = true;
            buffer.push({ type: 'init', continuation: sig.sessionId });
          }
        }
        if (sig.delta) resultText += sig.delta;
        if (sig.final !== undefined) finalText = sig.final;
        if (sig.finalIsError && !turn.error) {
          turn.error = new Error(sig.errorMessage || sig.final || 'kimi reported an error');
        }
        if (sig.errorMessage && !turn.error) turn.error = new Error(sig.errorMessage);
      };

      proc.stdout!.setEncoding('utf8');
      proc.stdout!.on('data', (chunk: string) => {
        for (const line of lb.push(chunk)) onLine(line);
        kick();
      });
      proc.stderr!.setEncoding('utf8');
      proc.stderr!.on('data', (chunk: string) => {
        stderrTail = (stderrTail + chunk).slice(-4000);
        buffer.push({ type: 'activity' });
        kick();
      });
      proc.on('error', (err) => {
        if (!turn.error) turn.error = err instanceof Error ? err : new Error(String(err));
        done = true;
        kick();
      });
      proc.on('close', (code) => {
        const last = lb.flush();
        if (last) onLine(last);
        if (code && code !== 0 && !turn.error) {
          const tail = stderrTail.trim();
          turn.error = new Error(`kimi exited with code ${code}${tail ? `: ${tail}` : ''}`);
        }
        done = true;
        kick();
      });

      const timer = setTimeout(() => {
        if (!turn.error) turn.error = new Error(`kimi turn timed out after ${TURN_TIMEOUT_MS}ms`);
        killProcess(proc);
        done = true;
        kick();
      }, TURN_TIMEOUT_MS);

      try {
        while (true) {
          while (buffer.length) yield buffer.shift()!;
          if (done || aborted) break;
          await new Promise<void>((resolve) => {
            waker = resolve;
          });
        }
        while (buffer.length) yield buffer.shift()!;
        if (aborted) return;

        if (!initYielded) {
          initYielded = true;
          sessionId = sessionId ?? RESUME_SENTINEL;
          yield { type: 'init', continuation: sessionId };
        }

        if (turn.error) {
          yield {
            type: 'error',
            message: turn.error.message,
            retryable: false,
            classification: classifyError(turn.error.message),
          };
          throw turn.error;
        }

        yield { type: 'result', text: finalText !== undefined ? finalText : resultText || null };
      } finally {
        clearTimeout(timer);
        activeProc = null;
        killProcess(proc);
      }
    }

    async function* gen(): AsyncGenerator<ProviderEvent> {
      try {
        while (!aborted) {
          while (pending.length === 0 && !ended && !aborted) {
            await new Promise<void>((resolve) => {
              waiting = resolve;
            });
          }
          if (aborted) return;
          if (pending.length === 0 && ended) return;
          const text = pending.shift()!;
          yield* runTurn(text);
        }
      } finally {
        if (activeProc) killProcess(activeProc);
      }
    }

    return {
      push: (message: string) => {
        pending.push(message);
        wake();
      },
      end: () => {
        ended = true;
        wake();
      },
      abort: () => {
        aborted = true;
        if (activeProc) killProcess(activeProc);
        wake();
      },
      events: gen(),
    };
  }
}

registerProvider('kimi', (opts) => new KimiProvider(opts));
