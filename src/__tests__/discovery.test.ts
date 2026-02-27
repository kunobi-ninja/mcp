import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_VARIANT_PORTS,
  getScanConfig,
  probeKunobiServer,
} from '../discovery.js';

describe('DEFAULT_VARIANT_PORTS', () => {
  it('contains all known variants', () => {
    expect(DEFAULT_VARIANT_PORTS).toEqual({
      legacy: 3030,
      stable: 3200,
      unstable: 3300,
      dev: 3400,
      local: 3500,
      e2e: 3600,
    });
  });
});

describe('getScanConfig', () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of [
      'MCP_KUNOBI_INTERVAL',
      'MCP_KUNOBI_PORTS',
      'MCP_KUNOBI_ENABLED',
      'MCP_KUNOBI_MISS_THRESHOLD',
    ]) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
  });

  it('returns defaults when no env vars are set', () => {
    const config = getScanConfig();
    expect(config.ports).toEqual(DEFAULT_VARIANT_PORTS);
    expect(config.intervalMs).toBe(5000);
    expect(config.missThreshold).toBe(3);
    expect(config.enabled).toBe(true);
  });

  it('respects MCP_KUNOBI_INTERVAL', () => {
    process.env.MCP_KUNOBI_INTERVAL = '10000';
    expect(getScanConfig().intervalMs).toBe(10000);
  });

  it('respects MCP_KUNOBI_PORTS to filter variants', () => {
    process.env.MCP_KUNOBI_PORTS = '3400,3500';
    const config = getScanConfig();
    expect(config.ports).toEqual({ dev: 3400, local: 3500 });
  });

  it('respects MCP_KUNOBI_ENABLED=false', () => {
    process.env.MCP_KUNOBI_ENABLED = 'false';
    expect(getScanConfig().enabled).toBe(false);
  });

  it('respects MCP_KUNOBI_MISS_THRESHOLD', () => {
    process.env.MCP_KUNOBI_MISS_THRESHOLD = '5';
    expect(getScanConfig().missThreshold).toBe(5);
  });
});

describe('probeKunobiServer', () => {
  it('returns null for unreachable port', async () => {
    const result = await probeKunobiServer('http://127.0.0.1:19999/mcp');
    expect(result).toBeNull();
  });
});
