import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest';
import type { McpConfig } from '../config.js';

// In-memory config store for test isolation
let memoryConfig: McpConfig = { variants: {} };

vi.mock('../config.js', () => ({
  DEFAULT_CONFIG_PATH: '/tmp/test-kunobi/mcp.json',
  CONFIG_DEFAULTS: {
    variants: {
      legacy: 3030,
      stable: 3200,
      unstable: 3300,
      dev: 3400,
      local: 3500,
      e2e: 3600,
    },
  },
  loadConfig: () => ({
    ...memoryConfig,
    variants: { ...memoryConfig.variants },
  }),
  saveConfig: (config: McpConfig) => {
    memoryConfig = { ...config, variants: { ...config.variants } };
  },
}));

vi.mock('../discovery.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../discovery.js')>();
  return { ...actual, probeKunobiServer: vi.fn().mockResolvedValue(null) };
});

import { probeKunobiServer } from '../discovery.js';
import { runAdd, runList, runRemove } from '../cli.js';

describe('runList', () => {
  let logSpy: MockInstance;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    memoryConfig = {
      variants: { dev: 3400, stable: 3200 },
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('displays header and config path', async () => {
    vi.mocked(probeKunobiServer).mockResolvedValue(null);
    await runList();

    const output = logSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(output).toContain('Kunobi MCP');
    expect(output).toContain('Config:');
  });

  it('shows connected status when probe succeeds', async () => {
    vi.mocked(probeKunobiServer).mockResolvedValue({
      tools: ['tool1', 'tool2'],
      serverName: 'kunobi',
    });
    await runList();

    const output = logSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(output).toContain('connected');
    expect(output).toContain('2 tools');
  });

  it('shows not detected when probe fails', async () => {
    vi.mocked(probeKunobiServer).mockResolvedValue(null);
    await runList();

    const output = logSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(output).toContain('not detected');
  });

  it('sorts variants by port number', async () => {
    vi.mocked(probeKunobiServer).mockResolvedValue(null);
    await runList();

    const lines = logSpy.mock.calls.map((c) => c[0]);
    const stableIdx = lines.findIndex(
      (l: string) => typeof l === 'string' && l.includes('stable'),
    );
    const devIdx = lines.findIndex(
      (l: string) => typeof l === 'string' && l.includes('dev'),
    );
    // stable (3200) should come before dev (3400)
    expect(stableIdx).toBeLessThan(devIdx);
  });
});

describe('runAdd', () => {
  let logSpy: MockInstance;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    memoryConfig = {
      variants: { dev: 3400, stable: 3200 },
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('adds a new variant to config', () => {
    runAdd('juan', 4200);

    const output = logSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(output).toContain('Adding');
    expect(output).toContain('juan');
    expect(output).toContain('4200');
    expect(memoryConfig.variants.juan).toBe(4200);
  });

  it('reports updating when variant already exists', () => {
    runAdd('dev', 9999);

    const output = logSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(output).toContain('Updating');
    expect(output).toContain('dev');
    expect(memoryConfig.variants.dev).toBe(9999);
  });

  it('preserves existing variants when adding', () => {
    runAdd('juan', 4200);

    expect(memoryConfig.variants.dev).toBe(3400);
    expect(memoryConfig.variants.stable).toBe(3200);
    expect(memoryConfig.variants.juan).toBe(4200);
  });
});

describe('runRemove', () => {
  let logSpy: MockInstance;
  let errorSpy: MockInstance;
  let exitSpy: MockInstance;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(() => undefined as never);
    memoryConfig = {
      variants: { dev: 3400, stable: 3200, local: 3500 },
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('removes an existing variant', () => {
    runRemove('dev');

    const output = logSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(output).toContain('Removed');
    expect(output).toContain('dev');
    expect(memoryConfig.variants).not.toHaveProperty('dev');
  });

  it('preserves other variants when removing', () => {
    runRemove('dev');

    expect(memoryConfig.variants.stable).toBe(3200);
    expect(memoryConfig.variants.local).toBe(3500);
  });

  it('exits with error for non-existent variant', () => {
    runRemove('nonexistent');

    const errOutput = errorSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(errOutput).toContain('not found');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('lists available variants in error message', () => {
    runRemove('nonexistent');

    const errOutput = errorSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(errOutput).toContain('dev');
    expect(errOutput).toContain('stable');
  });
});
