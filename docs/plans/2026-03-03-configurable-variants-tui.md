# Configurable Variant Ports + TUI Dashboard — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Allow users to configure custom variant→port mappings via a config file and env var, and provide an interactive TUI dashboard for managing config, viewing status, and installing the MCP server.

**Architecture:** Config file at `~/.config/kunobi/mcp.json` is auto-generated on first run with defaults. `getScanConfig()` reads config → merges env var on top. When run in an interactive terminal, the entry point shows an ink-based TUI instead of starting the MCP server.

**Tech Stack:** TypeScript, ink (React for terminal), ink-text-input, vitest

---

### Task 1: Config File Module (`src/config.ts`)

**Files:**
- Create: `src/config.ts`
- Test: `src/__tests__/config.test.ts`

**Step 1: Write the failing tests**

Create `src/__tests__/config.test.ts`:

```typescript
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, CONFIG_DEFAULTS, type McpConfig } from '../config.js';

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
```

**Step 2: Run tests to verify they fail**

Run: `pnpm test -- src/__tests__/config.test.ts`
Expected: FAIL — module `../config.js` not found

**Step 3: Write minimal implementation**

Create `src/config.ts`:

```typescript
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

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

export function loadConfig(configPath: string = DEFAULT_CONFIG_PATH): McpConfig {
  if (!existsSync(configPath)) {
    const dir = dirname(configPath);
    mkdirSync(dir, { recursive: true });
    writeFileSync(configPath, JSON.stringify(CONFIG_DEFAULTS, null, 2) + '\n');
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
```

**Step 4: Run tests to verify they pass**

Run: `pnpm test -- src/__tests__/config.test.ts`
Expected: PASS (all 5 tests)

**Step 5: Lint and commit**

```bash
pnpm check
git add src/config.ts src/__tests__/config.test.ts
git commit -m "feat: add config file module for variant port mappings"
```

---

### Task 2: Update `getScanConfig()` to Read Config + Merge Env

**Files:**
- Modify: `src/discovery.ts` — `getScanConfig()` function (lines 64-79)
- Modify: `src/__tests__/discovery.test.ts` — add new test cases
- Modify: `src/discovery.ts` — remove `DEFAULT_VARIANT_PORTS` export (moved to config.ts)

**Step 1: Write the failing tests**

Add to `src/__tests__/discovery.test.ts` (update existing imports and add new describe block):

```typescript
// Add these new tests to the existing file

describe('getScanConfig with config file', () => {
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

  it('parses name:port format in MCP_KUNOBI_PORTS', () => {
    process.env.MCP_KUNOBI_PORTS = 'juan:4200,test:5000';
    const config = getScanConfig();
    expect(config.ports.juan).toBe(4200);
    expect(config.ports.test).toBe(5000);
    // defaults still present
    expect(config.ports.stable).toBe(3200);
  });

  it('name:port entries override same-named defaults', () => {
    process.env.MCP_KUNOBI_PORTS = 'dev:9999';
    const config = getScanConfig();
    expect(config.ports.dev).toBe(9999);
    // other defaults still present
    expect(config.ports.stable).toBe(3200);
  });

  it('bare numbers still filter (backward compat)', () => {
    process.env.MCP_KUNOBI_PORTS = '3400,3500';
    const config = getScanConfig();
    expect(config.ports).toEqual({ dev: 3400, local: 3500 });
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `pnpm test -- src/__tests__/discovery.test.ts`
Expected: FAIL — name:port parsing not implemented

**Step 3: Update `getScanConfig()` implementation**

Modify `src/discovery.ts`:

1. Import `loadConfig` from `./config.js`
2. Keep `DEFAULT_VARIANT_PORTS` as a re-export from config for backward compat (existing tests reference it)
3. Update `getScanConfig()` to: read config file → apply env var merge

```typescript
// In discovery.ts — replace getScanConfig implementation

import { CONFIG_DEFAULTS, loadConfig } from './config.js';

export const DEFAULT_VARIANT_PORTS = CONFIG_DEFAULTS.variants;

export function getScanConfig(): ScanConfig {
  const enabled = process.env.MCP_KUNOBI_ENABLED !== 'false';
  const intervalMs = Number(process.env.MCP_KUNOBI_INTERVAL) || 5000;
  const missThreshold = Number(process.env.MCP_KUNOBI_MISS_THRESHOLD) || 3;

  const config = loadConfig();
  let ports = { ...config.variants };

  const portsEnv = process.env.MCP_KUNOBI_PORTS;
  if (portsEnv) {
    const entries = portsEnv.split(',').map((p) => p.trim());
    const hasNamedEntries = entries.some((e) => e.includes(':'));

    if (hasNamedEntries) {
      // New format: name:port pairs — merge on top
      for (const entry of entries) {
        const [name, portStr] = entry.split(':');
        const port = Number(portStr);
        if (name && !Number.isNaN(port)) {
          ports[name] = port;
        }
      }
    } else {
      // Legacy format: bare port numbers — filter
      const allowed = new Set(entries.map((p) => Number(p)));
      ports = Object.fromEntries(
        Object.entries(ports).filter(([, port]) => allowed.has(port)),
      );
    }
  }

  return { ports, intervalMs, missThreshold, enabled };
}
```

**Step 4: Run all tests to verify they pass**

Run: `pnpm test`
Expected: PASS (all tests including existing ones)

**Step 5: Lint and commit**

```bash
pnpm check
git add src/discovery.ts src/__tests__/discovery.test.ts
git commit -m "feat: getScanConfig reads config file and supports name:port env var format"
```

---

### Task 3: Update `kunobi_status` Tool to Show All Configured Variants

**Files:**
- Modify: `src/tools/status.ts` — show config file path and all configured ports
- Modify: `src/__tests__/status.test.ts` — update expectations

**Step 1: Read existing status test to understand current expectations**

Read `src/__tests__/status.test.ts` to see current assertions.

**Step 2: Update status tool**

In `src/tools/status.ts`, add a line at the end of `formatMultiStatus` showing the config file path:

```typescript
import { DEFAULT_CONFIG_PATH } from '../config.js';

// Add at end of formatMultiStatus, before return:
lines.push('', `Config: ${DEFAULT_CONFIG_PATH}`);
```

**Step 3: Run tests, fix any failures**

Run: `pnpm test -- src/__tests__/status.test.ts`

**Step 4: Commit**

```bash
pnpm check
git add src/tools/status.ts src/__tests__/status.test.ts
git commit -m "feat: show config file path in kunobi_status output"
```

---

### Task 4: Update Help Text and Server Instructions

**Files:**
- Modify: `src/server.ts` — update `--help` text and server instructions to document new config behavior

**Step 1: Update help text**

In `src/server.ts`, update the `--help` block to mention the config file and new env var format:

```
Commands:
  --install, -i       Register this MCP server with your AI clients
  --uninstall, -u     Remove this MCP server from your AI clients
  --help, -h          Show this help message
  --version, -v       Show version number

Configuration:
  Config file: ~/.config/kunobi/mcp.json (auto-generated on first run)
  Edit it to add custom variant ports.

Environment:
  MCP_KUNOBI_INTERVAL       Scan interval in ms (default: 5000)
  MCP_KUNOBI_PORTS          name:port pairs to merge (e.g. juan:4200,test:5000)
                             or bare port numbers to filter (legacy: 3400,3500)
  MCP_KUNOBI_ENABLED        Set "false" to disable scanning
  MCP_KUNOBI_MISS_THRESHOLD Misses before teardown (default: 3)
```

**Step 2: Update server instructions string**

Add mention of config file to the instructions string.

**Step 3: Run tests, lint, commit**

```bash
pnpm test
pnpm check
git add src/server.ts
git commit -m "docs: update help text and server instructions for config file"
```

---

### Task 5: Install ink Dependencies and Configure JSX Build

**Files:**
- Modify: `package.json` — add ink, react, ink-text-input dependencies
- Modify: `tsconfig.json` — enable JSX
- Modify: `rollup.config.mjs` — handle .tsx files

**Step 1: Install dependencies**

```bash
pnpm add ink react ink-text-input
pnpm add -D @types/react
```

**Step 2: Enable JSX in tsconfig**

Add to `compilerOptions` in `tsconfig.json`:

```json
"jsx": "react-jsx"
```

**Step 3: Update rollup to handle .tsx**

The rollup typescript plugin already handles TSX when `jsx` is set in tsconfig. Verify by building:

```bash
pnpm build
```

**Step 4: Commit**

```bash
git add package.json pnpm-lock.yaml tsconfig.json rollup.config.mjs
git commit -m "build: add ink/react dependencies and enable JSX support"
```

---

### Task 6: TUI Entry Point and TTY Detection

**Files:**
- Modify: `src/server.ts` — add TTY detection before MCP server startup
- Create: `src/tui/index.tsx` — TUI root entry

**Step 1: Add TTY detection to server.ts**

After the `--install`/`--uninstall` blocks and before MCP server setup, add:

```typescript
// If running in an interactive terminal (not piped by an MCP client), show TUI
if (process.stdin.isTTY && !arg) {
  const { runTui } = await import('./tui/index.js');
  await runTui();
  process.exit(0);
}
```

**Step 2: Create minimal TUI entry**

Create `src/tui/index.tsx`:

```tsx
import React from 'react';
import { render } from 'ink';
import { App } from './App.js';

export async function runTui(): Promise<void> {
  const { waitUntilExit } = render(<App />);
  await waitUntilExit();
}
```

Create `src/tui/App.tsx`:

```tsx
import React from 'react';
import { Box, Text } from 'ink';

export function App(): React.ReactElement {
  return (
    <Box flexDirection="column" padding={1}>
      <Text bold color="cyan">Kunobi MCP Configuration</Text>
      <Text dimColor>─────────────────────────</Text>
      <Text>TUI placeholder — sections coming next</Text>
    </Box>
  );
}
```

**Step 3: Build and test manually**

```bash
pnpm build
node dist/server.js  # should show TUI (because terminal is TTY)
```

**Step 4: Commit**

```bash
pnpm check
git add src/server.ts src/tui/
git commit -m "feat: add TUI entry point with TTY detection"
```

---

### Task 7: TUI Status View

**Files:**
- Create: `src/tui/StatusView.tsx` — live variant status display

**Step 1: Implement StatusView**

```tsx
import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { loadConfig, DEFAULT_CONFIG_PATH } from '../config.js';
import { probeKunobiServer } from '../discovery.js';

interface VariantStatus {
  name: string;
  port: number;
  status: 'checking' | 'connected' | 'not_detected';
  tools: string[];
}

export function StatusView(): React.ReactElement {
  const [variants, setVariants] = useState<VariantStatus[]>([]);
  const [scanning, setScanning] = useState(true);

  useEffect(() => {
    const config = loadConfig(DEFAULT_CONFIG_PATH);
    const entries = Object.entries(config.variants);

    setVariants(entries.map(([name, port]) => ({
      name, port, status: 'checking', tools: [],
    })));

    Promise.all(
      entries.map(async ([name, port]) => {
        const result = await probeKunobiServer(`http://127.0.0.1:${port}/mcp`);
        return {
          name,
          port,
          status: result ? 'connected' as const : 'not_detected' as const,
          tools: result?.tools ?? [],
        };
      }),
    ).then((results) => {
      setVariants(results);
      setScanning(false);
    });
  }, []);

  return (
    <Box flexDirection="column">
      <Text bold>Variant Status</Text>
      <Text dimColor>{'─'.repeat(50)}</Text>
      {variants.map((v) => (
        <Box key={v.name} gap={1}>
          <Text color={v.status === 'connected' ? 'green' : v.status === 'checking' ? 'yellow' : 'red'}>
            {v.status === 'connected' ? '●' : v.status === 'checking' ? '○' : '✗'}
          </Text>
          <Text>{v.name.padEnd(12)}</Text>
          <Text dimColor>port {v.port}</Text>
          {v.status === 'connected' && (
            <Text color="green">{v.tools.length} tools</Text>
          )}
        </Box>
      ))}
      {scanning && <Text color="yellow">Scanning...</Text>}
    </Box>
  );
}
```

**Step 2: Wire into App.tsx**

```tsx
import React from 'react';
import { Box, Text } from 'ink';
import { StatusView } from './StatusView.js';

export function App(): React.ReactElement {
  return (
    <Box flexDirection="column" padding={1}>
      <Text bold color="cyan">Kunobi MCP</Text>
      <Text dimColor>{'─'.repeat(30)}</Text>
      <Box marginTop={1}>
        <StatusView />
      </Box>
    </Box>
  );
}
```

**Step 3: Build and test manually**

```bash
pnpm build && node dist/server.js
```

**Step 4: Commit**

```bash
pnpm check
git add src/tui/
git commit -m "feat: add TUI status view with live variant probing"
```

---

### Task 8: TUI Config View

**Files:**
- Create: `src/tui/ConfigView.tsx` — config editor

**Step 1: Implement ConfigView**

The config view shows the current config file contents and provides instructions for editing. For adding a variant, use ink-text-input for inline editing.

```tsx
import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { loadConfig, DEFAULT_CONFIG_PATH, type McpConfig } from '../config.js';
import { existsSync, writeFileSync } from 'node:fs';

export function ConfigView(): React.ReactElement {
  const [config, setConfig] = useState<McpConfig>(() => loadConfig(DEFAULT_CONFIG_PATH));
  const [mode, setMode] = useState<'view' | 'add-name' | 'add-port' | 'delete'>('view');
  const [newName, setNewName] = useState('');
  const [newPort, setNewPort] = useState('');
  const [message, setMessage] = useState('');

  const entries = Object.entries(config.variants).sort(([, a], [, b]) => a - b);

  const saveConfig = (updated: McpConfig) => {
    writeFileSync(DEFAULT_CONFIG_PATH, JSON.stringify(updated, null, 2) + '\n');
    setConfig(updated);
  };

  useInput((input, key) => {
    if (mode !== 'view') return;
    if (input === 'a') {
      setMode('add-name');
      setNewName('');
      setNewPort('');
      setMessage('');
    }
    if (input === 'd') {
      setMode('delete');
      setMessage('');
    }
  });

  return (
    <Box flexDirection="column">
      <Text bold>Configuration</Text>
      <Text dimColor>{'─'.repeat(50)}</Text>
      <Text dimColor>File: {DEFAULT_CONFIG_PATH}</Text>
      <Box flexDirection="column" marginTop={1}>
        {entries.map(([name, port]) => (
          <Box key={name} gap={1}>
            <Text>{name.padEnd(12)}</Text>
            <Text dimColor>→</Text>
            <Text color="cyan">{port}</Text>
          </Box>
        ))}
      </Box>
      <Box marginTop={1}>
        {mode === 'view' && (
          <Text dimColor>[a] add variant  [d] delete variant</Text>
        )}
        {mode === 'add-name' && (
          <Box gap={1}>
            <Text>Variant name: </Text>
            <TextInput
              value={newName}
              onChange={setNewName}
              onSubmit={() => setMode('add-port')}
            />
          </Box>
        )}
        {mode === 'add-port' && (
          <Box gap={1}>
            <Text>Port for "{newName}": </Text>
            <TextInput
              value={newPort}
              onChange={setNewPort}
              onSubmit={() => {
                const port = Number(newPort);
                if (!newName || Number.isNaN(port)) {
                  setMessage('Invalid name or port');
                  setMode('view');
                  return;
                }
                const updated = {
                  variants: { ...config.variants, [newName]: port },
                };
                saveConfig(updated);
                setMessage(`Added ${newName}:${port}`);
                setMode('view');
              }}
            />
          </Box>
        )}
        {mode === 'delete' && (
          <Box gap={1}>
            <Text>Delete variant name: </Text>
            <TextInput
              value={newName}
              onChange={setNewName}
              onSubmit={() => {
                const { [newName]: _, ...rest } = config.variants;
                if (Object.keys(rest).length === Object.keys(config.variants).length) {
                  setMessage(`"${newName}" not found`);
                } else {
                  saveConfig({ variants: rest });
                  setMessage(`Removed ${newName}`);
                }
                setNewName('');
                setMode('view');
              }}
            />
          </Box>
        )}
      </Box>
      {message && <Text color="green">{message}</Text>}
    </Box>
  );
}
```

**Step 2: Wire into App.tsx with tab navigation**

Update `App.tsx` to have tabs: Status | Config | Install

```tsx
import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { StatusView } from './StatusView.js';
import { ConfigView } from './ConfigView.js';

type Tab = 'status' | 'config' | 'install';

export function App(): React.ReactElement {
  const [tab, setTab] = useState<Tab>('status');

  useInput((input, key) => {
    if (input === '1') setTab('status');
    if (input === '2') setTab('config');
    if (input === '3') setTab('install');
    if (key.escape || (input === 'q' && tab === 'status')) process.exit(0);
  });

  return (
    <Box flexDirection="column" padding={1}>
      <Text bold color="cyan">Kunobi MCP</Text>
      <Box gap={2}>
        <Text bold={tab === 'status'} color={tab === 'status' ? 'cyan' : undefined}>
          [1] Status
        </Text>
        <Text bold={tab === 'config'} color={tab === 'config' ? 'cyan' : undefined}>
          [2] Config
        </Text>
        <Text bold={tab === 'install'} color={tab === 'install' ? 'cyan' : undefined}>
          [3] Install
        </Text>
      </Box>
      <Text dimColor>{'─'.repeat(50)}</Text>
      <Box marginTop={1}>
        {tab === 'status' && <StatusView />}
        {tab === 'config' && <ConfigView />}
        {tab === 'install' && <Text dimColor>Install view coming next...</Text>}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>[1-3] switch tabs  [q/Esc] quit</Text>
      </Box>
    </Box>
  );
}
```

**Step 3: Build and test**

```bash
pnpm build && node dist/server.js
```

**Step 4: Commit**

```bash
pnpm check
git add src/tui/
git commit -m "feat: add TUI config editor with add/delete variant support"
```

---

### Task 9: TUI Install View

**Files:**
- Create: `src/tui/InstallView.tsx`

**Step 1: Implement InstallView**

```tsx
import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';

export function InstallView(): React.ReactElement {
  const [status, setStatus] = useState<string>('');
  const [busy, setBusy] = useState(false);

  useInput(async (input) => {
    if (busy) return;
    if (input === 'i') {
      setBusy(true);
      setStatus('Installing...');
      try {
        const { install } = await import('@kunobi/mcp-installer');
        await install({
          name: 'kunobi',
          command: 'npx',
          args: ['-y', '@kunobi/mcp'],
        });
        setStatus('Installed successfully! Restart your AI client to pick it up.');
      } catch (err) {
        setStatus(`Install failed: ${err}`);
      }
      setBusy(false);
    }
    if (input === 'u') {
      setBusy(true);
      setStatus('Uninstalling...');
      try {
        const { uninstall } = await import('@kunobi/mcp-installer');
        await uninstall({ name: 'kunobi' });
        setStatus('Uninstalled successfully.');
      } catch (err) {
        setStatus(`Uninstall failed: ${err}`);
      }
      setBusy(false);
    }
  });

  return (
    <Box flexDirection="column">
      <Text bold>MCP Server Registration</Text>
      <Text dimColor>{'─'.repeat(50)}</Text>
      <Text>Register or remove this MCP server from your AI clients</Text>
      <Text>(Claude Code, Cursor, Windsurf, etc.)</Text>
      <Box marginTop={1} gap={2}>
        <Text color={busy ? 'gray' : 'green'}>[i] Install</Text>
        <Text color={busy ? 'gray' : 'red'}>[u] Uninstall</Text>
      </Box>
      {status && (
        <Box marginTop={1}>
          <Text>{status}</Text>
        </Box>
      )}
    </Box>
  );
}
```

**Step 2: Wire into App.tsx**

Import `InstallView` and replace the placeholder in the install tab.

**Step 3: Build and test**

```bash
pnpm build && node dist/server.js
```

**Step 4: Commit**

```bash
pnpm check
git add src/tui/
git commit -m "feat: add TUI install view for MCP server registration"
```

---

### Task 10: Final Integration and Cleanup

**Files:**
- Modify: `src/server.ts` — update help text to mention TUI
- Modify: `src/__tests__/discovery.test.ts` — ensure existing test for `DEFAULT_VARIANT_PORTS` still passes with the new re-export
- Run full test suite

**Step 1: Update help text**

Add to the help output:

```
Running without arguments in a terminal opens the interactive TUI.
MCP clients (piped stdin) will start the MCP server as usual.
```

**Step 2: Run full test suite**

```bash
pnpm test
pnpm check
pnpm build
```

**Step 3: Manual smoke test**

1. Run `node dist/server.js` in terminal → TUI should appear
2. Press `2` → config view with all variants
3. Press `a` → add a variant (e.g., `juan:4200`)
4. Check `~/.config/kunobi/mcp.json` has the new entry
5. Press `1` → status view, `juan` should appear (as not_detected unless running)
6. Press `3` → install view
7. Set `MCP_KUNOBI_PORTS=test:8000` env var → restart → verify `test` appears

**Step 4: Commit**

```bash
git add -A
git commit -m "feat: configurable variant ports with TUI dashboard"
```
