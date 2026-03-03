import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CONFIG_DEFAULTS, loadConfig, type McpConfig } from '../config.js';

describe('loadConfig', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `kunobi-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('creates config file with defaults when none exists', () => {
    const configPath = join(tempDir, 'mcp.json');
    const config = loadConfig(configPath);
    expect(config.variants).toEqual(CONFIG_DEFAULTS.variants);
    expect(existsSync(configPath)).toBe(true);
  });

  it('reads existing config file', () => {
    const configPath = join(tempDir, 'mcp.json');
    const custom: McpConfig = { variants: { myvariant: 9999 } };
    writeFileSync(configPath, JSON.stringify(custom, null, 2));
    const config = loadConfig(configPath);
    expect(config.variants).toEqual({ myvariant: 9999 });
  });

  it('returns defaults if config file has invalid JSON', () => {
    const configPath = join(tempDir, 'mcp.json');
    writeFileSync(configPath, 'not json!!!');
    const config = loadConfig(configPath);
    expect(config.variants).toEqual(CONFIG_DEFAULTS.variants);
  });

  it('creates parent directories if they do not exist', () => {
    const configPath = join(tempDir, 'deep', 'nested', 'mcp.json');
    const config = loadConfig(configPath);
    expect(config.variants).toEqual(CONFIG_DEFAULTS.variants);
    expect(existsSync(configPath)).toBe(true);
  });
});

describe('CONFIG_DEFAULTS', () => {
  it('contains all 6 known variants', () => {
    expect(CONFIG_DEFAULTS.variants).toEqual({
      legacy: 3030,
      stable: 3200,
      unstable: 3300,
      dev: 3400,
      local: 3500,
      e2e: 3600,
    });
  });
});
