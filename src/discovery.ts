import { existsSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';

export function launchHint(): string {
  const os = platform();
  if (os === 'darwin') return 'Launch it from your Applications folder.';
  if (os === 'win32') return 'Launch it from the Start menu.';
  return 'Launch Kunobi from your app launcher or run it from the terminal.';
}

export function getLaunchCommand(
  variant: string,
): { command: string; args: string[] } | null {
  const os = platform();

  if (os === 'darwin') {
    return { command: 'open', args: ['-a', variant] };
  }

  if (os === 'linux') {
    const bin = variant.toLowerCase().replace(/\s+/g, '-');
    const dirs = [
      '/usr/bin',
      '/usr/local/bin',
      join(homedir(), '.local', 'bin'),
    ];
    for (const dir of dirs) {
      const p = join(dir, bin);
      if (existsSync(p)) return { command: p, args: [] };
    }
    return null;
  }

  if (os === 'win32') {
    const localAppData = process.env.LOCALAPPDATA;
    if (localAppData) {
      const exe = join(localAppData, variant, `${variant}.exe`);
      if (existsSync(exe)) return { command: exe, args: [] };
    }
    return null;
  }

  return null;
}

export const DEFAULT_VARIANT_PORTS: Record<string, number> = {
  legacy: 3030,
  stable: 3200,
  unstable: 3300,
  dev: 3400,
  local: 3500,
  e2e: 3600,
};

export interface ScanConfig {
  ports: Record<string, number>;
  intervalMs: number;
  missThreshold: number;
  enabled: boolean;
}

export function getScanConfig(): ScanConfig {
  const enabled = process.env.MCP_KUNOBI_ENABLED !== 'false';
  const intervalMs = Number(process.env.MCP_KUNOBI_INTERVAL) || 5000;
  const missThreshold = Number(process.env.MCP_KUNOBI_MISS_THRESHOLD) || 3;

  let ports = { ...DEFAULT_VARIANT_PORTS };
  const portsEnv = process.env.MCP_KUNOBI_PORTS;
  if (portsEnv) {
    const allowed = new Set(portsEnv.split(',').map((p) => Number(p.trim())));
    ports = Object.fromEntries(
      Object.entries(ports).filter(([, port]) => allowed.has(port)),
    );
  }

  return { ports, intervalMs, missThreshold, enabled };
}

const KUNOBI_VARIANTS = ['', ' Dev', ' Unstable', ' E2E', ' Local'] as const;

function variantLabel(suffix: string): string {
  return suffix ? `Kunobi${suffix}` : 'Kunobi';
}

export function findKunobiVariants(): string[] {
  const os = platform();
  const found: string[] = [];

  if (os === 'darwin') {
    const dirs = ['/Applications', join(homedir(), 'Applications')];
    for (const v of KUNOBI_VARIANTS) {
      if (dirs.some((dir) => existsSync(join(dir, `Kunobi${v}.app`)))) {
        found.push(variantLabel(v));
      }
    }
    return found;
  }

  if (os === 'linux') {
    const dirs = [
      '/usr/bin',
      '/usr/local/bin',
      join(homedir(), '.local', 'bin'),
    ];
    const linuxVariants: Array<[bin: string, label: string]> = [
      ['kunobi', 'Kunobi'],
      ['kunobi-dev', 'Kunobi Dev'],
      ['kunobi-unstable', 'Kunobi Unstable'],
      ['kunobi-e2e', 'Kunobi E2E'],
      ['kunobi-local', 'Kunobi Local'],
    ];
    for (const [bin, label] of linuxVariants) {
      if (dirs.some((dir) => existsSync(join(dir, bin)))) {
        found.push(label);
      }
    }
    return found;
  }

  if (os === 'win32') {
    const localAppData = process.env.LOCALAPPDATA;
    if (localAppData) {
      for (const v of KUNOBI_VARIANTS) {
        if (existsSync(join(localAppData, `Kunobi${v}`, `Kunobi${v}.exe`))) {
          found.push(variantLabel(v));
        }
      }
    }
    return found;
  }

  return found;
}

/**
 * Parse a response body that may be plain JSON or SSE-formatted (`data: {...}`).
 * Older Kunobi builds return SSE even for the probe endpoint.
 */
export async function parseJsonOrSse<T>(response: Response): Promise<T> {
  const text = await response.text();
  const trimmed = text.trim();
  if (trimmed.startsWith('data: ')) {
    // SSE format — extract the first `data:` line's JSON payload
    const jsonStr = trimmed.slice('data: '.length).split('\n')[0];
    return JSON.parse(jsonStr) as T;
  }
  return JSON.parse(trimmed) as T;
}

const PROBE_HEADERS = {
  'Content-Type': 'application/json',
  Accept: 'application/json, text/event-stream',
};

export async function probeKunobiServer(
  url: string,
): Promise<{ tools: string[]; serverName: string } | null> {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: PROBE_HEADERS,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: LATEST_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'kunobi-mcp-probe', version: '0.0.1' },
        },
      }),
      signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok) return null;

    const initBody = await parseJsonOrSse<{
      result?: { serverInfo?: { name?: string } };
    }>(response);
    const serverName = initBody.result?.serverInfo?.name ?? '';
    if (!serverName.toLowerCase().includes('kunobi')) return null;

    const sessionHeaders = {
      ...PROBE_HEADERS,
      ...(response.headers.has('mcp-session-id')
        ? { 'mcp-session-id': response.headers.get('mcp-session-id') ?? '' }
        : {}),
    };

    // Send notifications/initialized — required by the MCP protocol before
    // the server will accept further requests like tools/list.
    await fetch(url, {
      method: 'POST',
      headers: sessionHeaders,
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
      }),
      signal: AbortSignal.timeout(3_000),
    });

    const toolsResponse = await fetch(url, {
      method: 'POST',
      headers: sessionHeaders,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
        params: {},
      }),
      signal: AbortSignal.timeout(3_000),
    });
    if (!toolsResponse.ok) return { tools: [], serverName };

    const body = await parseJsonOrSse<{
      result?: { tools?: Array<{ name: string }> };
    }>(toolsResponse);
    return {
      tools: body.result?.tools?.map((t) => t.name) ?? [],
      serverName,
    };
  } catch {
    return null;
  }
}
