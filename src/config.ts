import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface McpConfig {
  variants: Record<string, number>;
}

export const CONFIG_DEFAULTS: McpConfig = {
  variants: {
    legacy: 3030,
    stable: 3200,
    unstable: 3300,
    dev: 3400,
    local: 3500,
    e2e: 3600,
  },
};

export const DEFAULT_CONFIG_PATH = join(
  homedir(),
  '.config',
  'kunobi',
  'mcp.json',
);

export function loadConfig(
  configPath: string = DEFAULT_CONFIG_PATH,
): McpConfig {
  if (!existsSync(configPath)) {
    const dir = dirname(configPath);
    mkdirSync(dir, { recursive: true });
    writeFileSync(configPath, `${JSON.stringify(CONFIG_DEFAULTS, null, 2)}\n`);
    return { ...CONFIG_DEFAULTS };
  }

  try {
    const raw = readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw) as McpConfig;
    if (parsed.variants && typeof parsed.variants === 'object') {
      return parsed;
    }
    return { ...CONFIG_DEFAULTS };
  } catch {
    return { ...CONFIG_DEFAULTS };
  }
}
