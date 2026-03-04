import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CONFIG_DEFAULTS,
  loadConfig,
  saveConfig,
  type McpConfig,
} from '../config.js';

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

describe('loadConfig edge cases', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `kunobi-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns defaults if config has no variants field', () => {
    const configPath = join(tempDir, 'mcp.json');
    writeFileSync(configPath, JSON.stringify({ other: 'data' }));
    const config = loadConfig(configPath);
    expect(config.variants).toEqual(CONFIG_DEFAULTS.variants);
  });

  it('returns defaults if variants is not an object', () => {
    const configPath = join(tempDir, 'mcp.json');
    writeFileSync(configPath, JSON.stringify({ variants: 'not-an-object' }));
    const config = loadConfig(configPath);
    expect(config.variants).toEqual(CONFIG_DEFAULTS.variants);
  });

  it('returns defaults for empty file', () => {
    const configPath = join(tempDir, 'mcp.json');
    writeFileSync(configPath, '');
    const config = loadConfig(configPath);
    expect(config.variants).toEqual(CONFIG_DEFAULTS.variants);
  });
});

describe('saveConfig', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `kunobi-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('writes config to file as formatted JSON', () => {
    const configPath = join(tempDir, 'mcp.json');
    const config: McpConfig = { variants: { custom: 9999 } };
    saveConfig(config, configPath);

    const raw = readFileSync(configPath, 'utf-8');
    expect(raw).toBe('{\n  "variants": {\n    "custom": 9999\n  }\n}\n');
  });

  it('creates parent directories if they do not exist', () => {
    const configPath = join(tempDir, 'deep', 'nested', 'mcp.json');
    saveConfig({ variants: { dev: 3400 } }, configPath);
    expect(existsSync(configPath)).toBe(true);
  });

  it('overwrites existing config file', () => {
    const configPath = join(tempDir, 'mcp.json');
    saveConfig({ variants: { old: 1111 } }, configPath);
    saveConfig({ variants: { new: 2222 } }, configPath);

    const config = loadConfig(configPath);
    expect(config.variants).toEqual({ new: 2222 });
    expect(config.variants).not.toHaveProperty('old');
  });
});
