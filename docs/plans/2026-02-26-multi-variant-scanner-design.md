# Multi-Variant Scanner Design

## Problem

The Kunobi desktop app now runs on variant-specific ports using the formula `port = 3000 + variant × 100 + slot` (MCP is slot 0). The `@kunobi/mcp` server currently connects to a single hardcoded endpoint (`http://127.0.0.1:3030/mcp`), which is the legacy port. It needs to discover and proxy multiple running variants simultaneously.

## Solution: Scanner + Bundler Pool (Approach A)

A new `VariantScanner` class periodically probes all known ports. When a Kunobi instance is confirmed, it creates a `McpBundler` with a variant prefix. When a variant disappears, it tears down the bundler. The MCP server remains a single stdio entry point for Claude.

```
Claude <--stdio--> McpServer
                     ├── kunobi_status (built-in, reports all variants)
                     ├── kunobi_launch (built-in)
                     └── VariantScanner (probes ports every 5s)
                           ├── McpBundler("legacy",   port 3030, prefix "legacy/")
                           ├── McpBundler("stable",   port 3200, prefix "stable/")
                           ├── McpBundler("dev",      port 3400, prefix "dev/")
                           └── McpBundler("e2e",      port 3600, prefix "e2e/")
```

## Port Map

Hardcoded, matching kunobi-frontend's formula:

| Variant  | Port | Prefix      |
|----------|------|-------------|
| legacy   | 3030 | `legacy/`   |
| stable   | 3200 | `stable/`   |
| unstable | 3300 | `unstable/` |
| dev      | 3400 | `dev/`      |
| local    | 3500 | `local/`    |
| e2e      | 3600 | `e2e/`      |

Every variant is prefixed — no exceptions.

## Kunobi Confirmation

When probing a port, the scanner sends an MCP `initialize` request and validates:
- Response is valid JSON-RPC
- `result.serverInfo.name` contains `"kunobi"` (case-insensitive)

Ports that respond but don't identify as Kunobi are ignored.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `KUNOBI_MCP_URL` | *(none)* | Legacy single-URL override, treated as "legacy" variant |
| `KUNOBI_SCAN_INTERVAL` | `5000` | Scan interval in ms |
| `KUNOBI_SCAN_PORTS` | *(all known)* | Comma-separated port override, e.g. `"3400,3500"` |
| `KUNOBI_SCAN_ENABLED` | `"true"` | Set `"false"` to disable scanning (only use `KUNOBI_MCP_URL`) |

## Scanner Lifecycle

### VariantScanner Class

```typescript
class VariantScanner {
  private server: McpServer;
  private bundlers: Map<string, McpBundler>;
  private missCounts: Map<string, number>;
  private interval: NodeJS.Timeout;

  constructor(server: McpServer, options: ScannerOptions)

  start(): void                              // begin scan loop
  stop(): Promise<void>                      // stop scanning, close all bundlers
  getStates(): Map<string, VariantState>     // for status tool
}

interface ScannerOptions {
  ports: Record<string, number>;    // variant name → port
  intervalMs: number;               // scan interval (default 5000)
  missThreshold: number;            // consecutive misses before teardown (default 3)
}
```

### Scan Cycle

Every tick:

1. Probe all ports in parallel (HTTP POST, 3s timeout each)
2. For each port that responds and confirms as Kunobi:
   - If **new** → create `McpBundler`, connect, register tools with `variant/` prefix, send `toolListChanged`
   - If **already tracked** → no-op (bundler handles its own reconnect)
3. For each tracked variant that didn't respond:
   - Increment miss count
   - After `missThreshold` consecutive misses (default 3 = 15s) → tear down bundler, unregister tools, send `toolListChanged`

### Why not tear down immediately?

A variant might restart (e.g. hot-reload in dev). The bundler's reconnect handles transient failures. The scanner only cleans up after sustained absence to avoid tool list flapping.

### Bundler Configuration Per Variant

```typescript
new McpBundler({
  name: variant,
  transport: { type: 'http', url: `http://127.0.0.1:${port}/mcp` },
  reconnect: {
    enabled: true,
    intervalMs: scanInterval,
    maxRetries: Infinity,
  },
})
```

Tools registered with `bundler.registerTools(server, `${variant}/`)`.

## Built-in Tools (Updated)

### `kunobi_status`

Reports all variants and their states:

```
Kunobi MCP Hub Status
─────────────────────
Variants:
  ✓ dev      (port 3400) — connected, 12 tools
  ✓ e2e      (port 3600) — connected, 12 tools
  ✗ stable   (port 3200) — not detected
  ✗ unstable (port 3300) — not detected
  ✗ local    (port 3500) — not detected
  ✗ legacy   (port 3030) — not detected

Installed on system: Kunobi, Kunobi Dev

Scan interval: 5000ms
```

### `kunobi_launch`

Unchanged — already accepts variant parameter.

### `kunobi-setup` prompt

Context-aware across all variants.

### `kunobi-doctor` prompt

Expanded diagnostics:
- Which ports are scanned
- Which responded but weren't Kunobi (port conflicts)
- Which bundlers are in reconnect state
- Scan interval and miss counts

### `kunobi://status` resource

Returns full variant map as JSON:

```json
{
  "variants": {
    "dev":      { "port": 3400, "status": "connected", "tools": ["dev/list_clusters", "..."] },
    "e2e":      { "port": 3600, "status": "connected", "tools": ["e2e/list_clusters", "..."] },
    "stable":   { "port": 3200, "status": "not_detected" },
    "unstable": { "port": 3300, "status": "not_detected" },
    "local":    { "port": 3500, "status": "not_detected" },
    "legacy":   { "port": 3030, "status": "not_detected" }
  },
  "installedVariants": ["Kunobi", "Kunobi Dev"],
  "scanInterval": 5000
}
```

## Server Orchestration

### New `server.ts` flow

```
1. Parse CLI args (unchanged)
2. Create McpServer
3. Create VariantScanner(server, options)
4. Register built-in tools — scanner injected for state access
5. Register resource + prompts — scanner injected for state access
6. Connect stdio transport
7. scanner.start() — begins scan loop, manages bundlers internally
```

### File structure

```
src/
  server.ts          — entry point, wiring (simplified)
  scanner.ts         — NEW: VariantScanner class
  discovery.ts       — updated: port map, probe with kunobi validation
  tools/
    status.ts        — updated: multi-variant status
    launch.ts        — mostly unchanged
```

## Decisions

- Every variant is always prefixed (`variant/tool_name`), no exceptions
- Port scanning with Kunobi identity confirmation via `serverInfo.name`
- Tear down after 3 consecutive scan misses (configurable)
- All settings configurable via environment variables
- McpBundler package unchanged — it already supports prefixing
