/**
 * Host-side container config for the `kimi` provider.
 *
 * The Kimi Code CLI keeps its auth and conversation state under a config home
 * (`KIMI_CODE_HOME`, default `~/.kimi-code`). We pin that to a per-session host
 * directory mounted at `/home/node/.kimi-code`, and seed it on first spawn from
 * the operator's host `~/.kimi-code` so the in-container CLI is already logged
 * in (Codex's auth-file pattern). No API key ever enters container env — auth
 * is purely file-based.
 *
 * NO_PROXY / no_proxy are merged with host values so the CLI's HTTPS calls to
 * api.kimi.com / code.kimi.com bypass the OneCLI gateway (which holds no Kimi
 * credentials) and reach Kimi directly.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { registerProviderContainerConfig } from './provider-container-registry.js';

function mergeNoProxy(current: string | undefined, additions: string): string {
  if (!current?.trim()) return additions;
  const parts = new Set(
    current
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean),
  );
  for (const addition of additions.split(',')) {
    const trimmed = addition.trim();
    if (trimmed) parts.add(trimmed);
  }
  return [...parts].join(',');
}

/**
 * Seed the per-session config home from the operator's `~/.kimi-code`. Kimi
 * stores auth across several entries — `config.toml`, the `credentials/` dir
 * (OAuth tokens), and `device_id` — so we copy everything except runtime noise
 * (`logs/`) and any host-arch binary dir (`bin/`). Never clobbers entries the
 * container has already written on a prior wake (token refresh stays local).
 * `mcp.json` and `AGENTS.md` are excluded — the container provider writes those
 * itself (from the group's MCP config and composed CLAUDE.md).
 */
const SEED_SKIP = new Set([
  'logs',
  'bin',
  'cache',
  '.cache',
  'tmp',
  'mcp.json',
  'AGENTS.md',
  '.agents-hash',
]);

function seedKimiAuth(srcDir: string, destDir: string): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(srcDir, { withFileTypes: true });
  } catch {
    return; // operator has no ~/.kimi-code yet — nothing to seed
  }
  for (const entry of entries) {
    if (SEED_SKIP.has(entry.name)) continue;
    const dest = path.join(destDir, entry.name);
    if (fs.existsSync(dest)) continue;
    try {
      fs.cpSync(path.join(srcDir, entry.name), dest, { recursive: true });
    } catch {
      /* best effort */
    }
  }
}

registerProviderContainerConfig('kimi', (ctx) => {
  const kimiDir = path.join(ctx.sessionDir, 'kimi-code');
  fs.mkdirSync(kimiDir, { recursive: true });

  const hostHome = ctx.hostEnv.HOME || os.homedir();
  if (hostHome) seedKimiAuth(path.join(hostHome, '.kimi-code'), kimiDir);

  const noProxyAdditions = 'api.kimi.com,code.kimi.com';
  const env: Record<string, string> = {
    KIMI_CODE_HOME: '/home/node/.kimi-code',
    NO_PROXY: mergeNoProxy(ctx.hostEnv.NO_PROXY, noProxyAdditions),
    no_proxy: mergeNoProxy(ctx.hostEnv.no_proxy, noProxyAdditions),
  };
  // Optional passthroughs: a model alias the CLI may honor, or an alternate
  // binary name/path for the container.
  for (const key of ['KIMI_CODE_MODEL', 'KIMI_BIN'] as const) {
    const value = ctx.hostEnv[key];
    if (value) env[key] = value;
  }

  return {
    mounts: [{ hostPath: kimiDir, containerPath: '/home/node/.kimi-code', readonly: false }],
    env,
  };
});
