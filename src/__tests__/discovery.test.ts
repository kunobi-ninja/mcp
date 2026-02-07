import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectKunobi, getMcpUrl } from '../discovery.js';

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
