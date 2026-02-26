import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_VARIANT_PORTS,
  detectKunobi,
  getMcpUrl,
  getScanConfig,
  probeKunobiServer,
} from '../discovery.js';

describe('getMcpUrl', () => {
  const originalEnv = process.env.KUNOBI_MCP_URL;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.KUNOBI_MCP_URL;
    } else {
      process.env.KUNOBI_MCP_URL = originalEnv;
    }
  });

  it('returns default URL when env is not set', () => {
    delete process.env.KUNOBI_MCP_URL;
    expect(getMcpUrl()).toBe('http://127.0.0.1:3030/mcp');
  });

  it('returns env override when set', () => {
    process.env.KUNOBI_MCP_URL = 'http://127.0.0.1:4000/mcp';
    expect(getMcpUrl()).toBe('http://127.0.0.1:4000/mcp');
  });
});

describe('detectKunobi', () => {
  beforeEach(() => {
    // Ensure no env override
    delete process.env.KUNOBI_MCP_URL;
  });

  it('returns a valid state object', async () => {
    const state = await detectKunobi();
    expect(state).toHaveProperty('status');
    expect([
      'not_installed',
      'installed_not_running',
      'running_mcp_unreachable',
      'connected',
    ]).toContain(state.status);
  });

  it('returns not_installed or installed_not_running when no server is running', async () => {
    // Point to a port that definitely has no MCP server
    process.env.KUNOBI_MCP_URL = 'http://127.0.0.1:19999/mcp';
    const state = await detectKunobi();
    // Without Kunobi running, we should get one of these states
    expect([
      'not_installed',
      'installed_not_running',
      'running_mcp_unreachable',
    ]).toContain(state.status);
  });
});

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
      'KUNOBI_SCAN_INTERVAL',
      'KUNOBI_SCAN_PORTS',
      'KUNOBI_SCAN_ENABLED',
      'KUNOBI_SCAN_MISS_THRESHOLD',
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

  it('respects KUNOBI_SCAN_INTERVAL', () => {
    process.env.KUNOBI_SCAN_INTERVAL = '10000';
    expect(getScanConfig().intervalMs).toBe(10000);
  });

  it('respects KUNOBI_SCAN_PORTS to filter variants', () => {
    process.env.KUNOBI_SCAN_PORTS = '3400,3500';
    const config = getScanConfig();
    expect(config.ports).toEqual({ dev: 3400, local: 3500 });
  });

  it('respects KUNOBI_SCAN_ENABLED=false', () => {
    process.env.KUNOBI_SCAN_ENABLED = 'false';
    expect(getScanConfig().enabled).toBe(false);
  });

  it('respects KUNOBI_SCAN_MISS_THRESHOLD', () => {
    process.env.KUNOBI_SCAN_MISS_THRESHOLD = '5';
    expect(getScanConfig().missThreshold).toBe(5);
  });
});

describe('probeKunobiServer', () => {
  it('returns null for unreachable port', async () => {
    const result = await probeKunobiServer('http://127.0.0.1:19999/mcp');
    expect(result).toBeNull();
  });
});
