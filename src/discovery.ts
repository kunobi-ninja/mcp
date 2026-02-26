import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';

export type KunobiState =
  | { status: 'not_installed' }
  | { status: 'installed_not_running'; variants: string[] }
  | { status: 'running_mcp_unreachable'; pid: number; variants: string[] }
  | { status: 'connected'; pid: number; tools: string[]; variants: string[] };

interface LockFileData {
  pid: number;
  workspaceFolders: string[];
  ideName: string;
  transport: string;
  authToken: string;
}

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
  const enabled = process.env.KUNOBI_SCAN_ENABLED !== 'false';
  const intervalMs = Number(process.env.KUNOBI_SCAN_INTERVAL) || 5000;
  const missThreshold = Number(process.env.KUNOBI_SCAN_MISS_THRESHOLD) || 3;

  let ports = { ...DEFAULT_VARIANT_PORTS };
  const portsEnv = process.env.KUNOBI_SCAN_PORTS;
  if (portsEnv) {
    const allowed = new Set(portsEnv.split(',').map((p) => Number(p.trim())));
    ports = Object.fromEntries(
      Object.entries(ports).filter(([, port]) => allowed.has(port)),
    );
  }

  return { ports, intervalMs, missThreshold, enabled };
}

const DEFAULT_MCP_URL = 'http://127.0.0.1:3030/mcp';

export function getMcpUrl(): string {
  return process.env.KUNOBI_MCP_URL || DEFAULT_MCP_URL;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function getLockDirectory(): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
  return join(configDir, 'ide');
}

async function findKunobiLockFile(): Promise<LockFileData | null> {
  const lockDir = getLockDirectory();
  if (!existsSync(lockDir)) return null;

  try {
    const files = await readdir(lockDir);
    const lockFiles = files.filter((f) => f.endsWith('.lock'));

    for (const file of lockFiles) {
      try {
        const content = await readFile(join(lockDir, file), 'utf-8');
        const data: LockFileData = JSON.parse(content);
        if (data.ideName === 'Kunobi' && isProcessAlive(data.pid)) {
          return data;
        }
      } catch {
        // Skip malformed lock files
      }
    }
  } catch {
    // Lock directory read failed
  }

  return null;
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

export async function probeKunobiServer(
  url: string,
): Promise<{ tools: string[]; serverName: string } | null> {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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

    const initBody = (await response.json()) as {
      result?: { serverInfo?: { name?: string } };
    };
    const serverName = initBody.result?.serverInfo?.name ?? '';
    if (!serverName.toLowerCase().includes('kunobi')) return null;

    const toolsResponse = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(response.headers.has('mcp-session-id')
          ? { 'mcp-session-id': response.headers.get('mcp-session-id') ?? '' }
          : {}),
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
        params: {},
      }),
      signal: AbortSignal.timeout(3_000),
    });
    if (!toolsResponse.ok) return { tools: [], serverName };

    const body = (await toolsResponse.json()) as {
      result?: { tools?: Array<{ name: string }> };
    };
    return {
      tools: body.result?.tools?.map((t) => t.name) ?? [],
      serverName,
    };
  } catch {
    return null;
  }
}

export async function detectKunobi(): Promise<KunobiState> {
  const lockFile = await findKunobiLockFile();
  const mcpUrl = getMcpUrl();
  const variants = findKunobiVariants();

  // Check if MCP server is reachable
  const result = await probeKunobiServer(mcpUrl);

  if (result !== null) {
    return {
      status: 'connected',
      pid: lockFile?.pid ?? 0,
      tools: result.tools,
      variants,
    };
  }

  // MCP not reachable — check if running via lock file
  if (lockFile) {
    return {
      status: 'running_mcp_unreachable',
      pid: lockFile.pid,
      variants,
    };
  }

  // Not running — check if installed
  if (variants.length > 0) {
    return { status: 'installed_not_running', variants };
  }

  return { status: 'not_installed' };
}
