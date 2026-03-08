import { existsSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { CONFIG_DEFAULTS, loadConfig } from './config.js';

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

export const DEFAULT_VARIANT_PORTS = CONFIG_DEFAULTS.variants;

export interface ConnectionConfig {
  ports: Record<string, number>;
  reconnectIntervalMs: number;
  autoConnect: boolean;
}

export function getConnectionConfig(): ConnectionConfig {
  const autoConnect = process.env.MCP_KUNOBI_AUTO_CONNECT !== 'false';
  const reconnectIntervalMs =
    Number(process.env.MCP_KUNOBI_RECONNECT_INTERVAL_MS) || 5000;

  const config = loadConfig();
  const ports = { ...config.variants };

  const variantsEnv = process.env.MCP_KUNOBI_VARIANTS;
  if (variantsEnv) {
    const entries = variantsEnv.split(',').map((entry) => entry.trim());
    for (const entry of entries) {
      const [name, portStr] = entry.split(':');
      const port = Number(portStr);
      if (name && !Number.isNaN(port)) {
        ports[name] = port;
      }
    }
  }

  return { ports, reconnectIntervalMs, autoConnect };
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
 * Older Kunobi builds return SSE even for this inspection endpoint.
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

const INSPECTION_HEADERS = {
  'Content-Type': 'application/json',
  Accept: 'application/json, text/event-stream',
  'X-Kunobi-Client': '@kunobi/mcp',
};

export async function inspectKunobiServer(
  url: string,
): Promise<{ tools: string[]; serverName: string } | null> {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: INSPECTION_HEADERS,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: LATEST_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'kunobi-mcp-inspector', version: '0.0.1' },
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
      ...INSPECTION_HEADERS,
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
