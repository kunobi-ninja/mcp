# LLM Awareness Improvements — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make LLMs fully aware of how the Kunobi MCP hub works, add on-demand rescan capability, and show scan freshness in status output.

**Architecture:** Add `instructions` to `ServerOptions`, enrich tool descriptions, make `scan()` public with timestamp tracking, add `kunobi_refresh` tool that triggers immediate rescan.

**Tech Stack:** TypeScript, @modelcontextprotocol/sdk, vitest

---

### Task 1: Make `scan()` public and track `lastScanTime` in scanner

**Files:**
- Modify: `src/scanner.ts` (make `scan()` public, add `lastScanTime` field + getter)
- Modify: `src/__tests__/scanner.test.ts` (test the new public API)

**Step 1: Write the failing test**

In `src/__tests__/scanner.test.ts`, add to the existing describe block:

```typescript
it('exposes lastScanTime after a scan', async () => {
  expect(scanner.getLastScanTime()).toBeNull();
  // After start(), first scan runs immediately
  await vi.advanceTimersByTimeAsync(0);
  expect(scanner.getLastScanTime()).toBeInstanceOf(Date);
});
```

**Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `getLastScanTime` does not exist on `VariantScanner`

**Step 3: Implement in scanner.ts**

In `src/scanner.ts`, add the field and getter:

```typescript
// Add field after existing private fields
private lastScanTime: Date | null = null;

// Add public getter
getLastScanTime(): Date | null {
  return this.lastScanTime;
}
```

Change `private async scan()` to `async scan()` (remove `private`).

At the end of `scan()`, inside the `try` block (after the miss-handling loop), add:

```typescript
this.lastScanTime = new Date();
```

**Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS

**Step 5: Commit**

```
feat: make scan() public and track lastScanTime in VariantScanner
```

---

### Task 2: Add `Last scanned` to status output and enrich description

**Files:**
- Modify: `src/tools/status.ts` (add timestamp line, update description)
- Modify: `src/__tests__/status.test.ts` (test timestamp output)

**Step 1: Write the failing test**

In `src/__tests__/status.test.ts`, add a new test:

```typescript
it('includes last scanned timestamp', async () => {
  const server = createServer();
  const lastScan = new Date(Date.now() - 3000);
  const scanner = {
    ...mockScanner({
      dev: { port: 3400, status: 'connected', tools: ['dev/foo'] },
    }),
    getLastScanTime: () => lastScan,
  } as unknown as VariantScanner;
  registerStatusTool(server, scanner);

  const tool = (server as unknown as ServerInternals)._registeredTools
    .kunobi_status;
  const result = await tool.handler({});
  expect(result.content[0].text).toContain('Last scanned:');
  expect(result.content[0].text).toContain('ago');
});
```

**Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — output doesn't contain "Last scanned:"

**Step 3: Implement**

In `src/tools/status.ts`:

1. Update the description:

```typescript
description:
  'Check which Kunobi variants are currently connected to this hub. Reports each variant\'s port, connection status, available tools, and when the last scan occurred. Call this before using Kunobi tools to understand what\'s available.',
```

2. Add a helper and the timestamp line in `formatMultiStatus`:

```typescript
function formatMultiStatus(scanner: VariantScanner): string {
  const states = scanner.getStates();
  const lines: string[] = [
    'Kunobi MCP Hub Status',
    '─────────────────────',
    'Variants:',
  ];

  // ... existing variant lines (unchanged) ...

  const installed = findKunobiVariants();
  if (installed.length > 0) {
    lines.push('', `Installed on system: ${installed.join(', ')}`);
  }

  const lastScan = scanner.getLastScanTime();
  if (lastScan) {
    const agoMs = Date.now() - lastScan.getTime();
    const agoSec = Math.round(agoMs / 1000);
    lines.push(`Last scanned: ${agoSec}s ago`);
  }

  return lines.join('\n');
}
```

**Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS

**Step 5: Commit**

```
feat: add last-scanned timestamp to kunobi_status output
```

---

### Task 3: Add `kunobi_refresh` tool

**Files:**
- Create: `src/tools/refresh.ts`
- Modify: `src/server.ts` (register the new tool)
- Modify: `src/__tests__/server.test.ts` (verify registration)

**Step 1: Write the failing test**

In `src/__tests__/server.test.ts`, add a new test in the existing describe block:

```typescript
import { registerRefreshTool } from '../tools/refresh.js';

// ... inside 'built-in tools registration' describe:

it('kunobi_refresh is registered with correct annotations', () => {
  const server = createServer();
  const scanner = mockScanner({});
  registerRefreshTool(server, scanner);

  const tool = (server as unknown as ServerInternals)._registeredTools
    .kunobi_refresh;
  expect(tool).toBeDefined();
  expect(tool.annotations?.readOnlyHint).toBe(true);
  expect(tool.annotations?.destructiveHint).toBe(false);
});
```

**Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — module `../tools/refresh.js` not found

**Step 3: Create `src/tools/refresh.ts`**

```typescript
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { findKunobiVariants } from '../discovery.js';
import type { VariantScanner } from '../scanner.js';

function formatRefreshResult(scanner: VariantScanner): string {
  const states = scanner.getStates();
  const lines: string[] = ['Scan complete. Current status:'];

  for (const [variant, state] of states) {
    const icon = state.status === 'connected' ? '✓' : '✗';
    const detail =
      state.status === 'connected'
        ? `connected, ${state.tools.length} tools`
        : state.status === 'connecting'
          ? 'connecting...'
          : state.status === 'disconnected'
            ? 'disconnected (reconnecting)'
            : 'not detected';
    lines.push(
      `  ${icon} ${variant.padEnd(10)} (port ${state.port}) — ${detail}`,
    );
  }

  const installed = findKunobiVariants();
  if (installed.length > 0) {
    lines.push('', `Installed on system: ${installed.join(', ')}`);
  }

  return lines.join('\n');
}

export function registerRefreshTool(
  server: McpServer,
  scanner: VariantScanner,
): void {
  server.registerTool(
    'kunobi_refresh',
    {
      description:
        'Force an immediate rescan of all Kunobi variant ports. Use this after launching Kunobi or when kunobi_status shows stale data. Returns the fresh connection status for all variants.',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async () => {
      await scanner.scan();
      return {
        content: [
          { type: 'text' as const, text: formatRefreshResult(scanner) },
        ],
      };
    },
  );
}
```

**Step 4: Register in server.ts**

Add import:
```typescript
import { registerRefreshTool } from './tools/refresh.js';
```

After the existing `registerLaunchTool(server)` line, add:
```typescript
registerRefreshTool(server, scanner);
```

**Step 5: Run test to verify it passes**

Run: `npm test`
Expected: PASS

**Step 6: Commit**

```
feat: add kunobi_refresh tool for on-demand variant rescan
```

---

### Task 4: Add server `instructions` and enrich `kunobi_launch` description

**Files:**
- Modify: `src/server.ts` (add `instructions` to ServerOptions, update launch description)
- Modify: `src/tools/launch.ts` (update description)

**Step 1: Add instructions to server.ts**

Change the `McpServer` constructor call:

```typescript
const server = new McpServer(
  { name: 'kunobi', version },
  {
    capabilities: { tools: { listChanged: true }, logging: {} },
    instructions: [
      'Kunobi is a platform engineering desktop app (https://kunobi.ninja). This MCP server is a hub that automatically discovers and connects to running Kunobi instances. Multiple variants may run simultaneously (legacy, stable, unstable, dev, etc.), each on a dedicated port.',
      '',
      'When a Kunobi variant connects, its tools are registered here with a prefixed name: e.g. a tool "get_pod_logs" from the "dev" variant appears as "dev/get_pod_logs". Tools appear and disappear dynamically as Kunobi variants start and stop.',
      '',
      'If Kunobi is not installed, it can be downloaded from https://kunobi.ninja/downloads',
      '',
      'Available hub tools:',
      '- kunobi_status: Check which variants are connected and when the last scan occurred. Call this first to understand what\'s available.',
      '- kunobi_launch: Start the Kunobi desktop app if no variants are detected.',
      '- kunobi_refresh: Force an immediate rescan of all variant ports. Use after launching Kunobi or when kunobi_status shows stale data.',
      '',
      'Typical workflow:',
      '1. Call kunobi_status to see what\'s connected',
      '2. If nothing is connected, call kunobi_launch then kunobi_refresh',
      '3. Use the variant-prefixed tools (e.g. stable/get_pod_logs) for operations',
    ].join('\n'),
  },
);
```

**Step 2: Update launch tool description in `src/tools/launch.ts`**

```typescript
description:
  'Launch the Kunobi desktop app. Optionally specify a variant (e.g. "Kunobi Dev"). If no variant is specified, launches the first installed one. After launching, call kunobi_refresh to detect the new instance immediately instead of waiting for the next automatic scan.',
```

**Step 3: Run tests**

Run: `npm test`
Expected: PASS (no tests depend on exact description text)

**Step 4: Build and verify**

Run: `npm run build`
Expected: clean build

**Step 5: Commit**

```
feat: add server instructions and enrich tool descriptions for LLM awareness
```

---

### Task 5: Update prompts to mention `kunobi_refresh`

**Files:**
- Modify: `src/server.ts` (update kunobi-setup and kunobi-doctor prompts)

**Step 1: Update kunobi-setup prompt**

In the `installed but not running` branch, change:

```typescript
instructions = `Kunobi is installed but no variants are running (found: ${installed.join(', ')}). ${launchHint()} Use kunobi_launch to start it, then kunobi_refresh to detect it immediately.`;
```

**Step 2: Update kunobi-doctor prompt**

In the `installed but not running` steps, change step 2:

```typescript
steps.push(
  `Kunobi is installed (${installed.join(', ')}) but no variants are running.`,
  `1. ${launchHint()} Or call kunobi_launch.`,
  '2. Call kunobi_refresh to detect the new instance immediately',
  '3. Tools will appear automatically once connected',
);
```

**Step 3: Run tests and build**

Run: `npm test && npm run build`
Expected: PASS, clean build

**Step 4: Commit**

```
feat: update prompts to guide LLMs toward kunobi_refresh
```
