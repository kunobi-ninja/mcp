import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

export type KunobiState =
  | { status: 'not_installed' }
  | { status: 'installed_not_running' }
  | { status: 'running_mcp_unreachable'; pid: number }
  | { status: 'connected'; pid: number; tools: string[] };

interface LockFileData {
  pid: number;
  workspaceFolders: string[];
  ideName: string;
  transport: string;
  authToken: string;
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

function isKunobiInstalled(): boolean {
  const os = platform();

  if (os === 'darwin') {
    return (
      existsSync('/Applications/Kunobi.app') ||
      existsSync(join(homedir(), 'Applications', 'Kunobi.app'))
    );
  }

  if (os === 'linux') {
    const paths = [
      '/usr/bin/kunobi',
      '/usr/local/bin/kunobi',
      join(homedir(), '.local', 'bin', 'kunobi'),
    ];
    return paths.some((p) => existsSync(p));
  }

  // Windows — check common install location
  if (os === 'win32') {
    const localAppData = process.env.LOCALAPPDATA;
    if (localAppData) {
      return existsSync(join(localAppData, 'Kunobi', 'Kunobi.exe'));
    }
  }

  return false;
}

async function probeMcpServer(url: string): Promise<string[] | null> {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'kunobi-mcp-probe', version: '0.0.1' },
        },
      }),
      signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok) return null;

    // If we got a valid response, probe for tools
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
    if (!toolsResponse.ok) return [];

    const body = (await toolsResponse.json()) as {
      result?: { tools?: Array<{ name: string }> };
    };
    return body.result?.tools?.map((t) => t.name) ?? [];
  } catch {
    return null;
  }
}

export async function detectKunobi(): Promise<KunobiState> {
  const lockFile = await findKunobiLockFile();
  const mcpUrl = getMcpUrl();

  // Check if MCP server is reachable
  const tools = await probeMcpServer(mcpUrl);

  if (tools !== null) {
    return {
      status: 'connected',
      pid: lockFile?.pid ?? 0,
      tools,
    };
  }

  // MCP not reachable — check if running via lock file
  if (lockFile) {
    return {
      status: 'running_mcp_unreachable',
      pid: lockFile.pid,
    };
  }

  // Not running — check if installed
  if (isKunobiInstalled()) {
    return { status: 'installed_not_running' };
  }

  return { status: 'not_installed' };
}
