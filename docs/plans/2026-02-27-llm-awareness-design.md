# Improve LLM Awareness of Kunobi MCP Hub

**Date:** 2026-02-27
**Status:** Approved

## Problem

LLMs connecting to this MCP server receive almost no context about what Kunobi is, how the hub/variant architecture works, or how to use the tools effectively. There is also no way to trigger an on-demand rescan — the LLM must wait for the periodic poll (default 5s) after launching Kunobi.

## Design

### 1. Server Instructions

Add an `instructions` field to the `McpServer` constructor so LLMs receive full context on connection:

```
Kunobi is a platform engineering desktop app (https://kunobi.ninja). This MCP
server is a hub that automatically discovers and connects to running Kunobi
instances. Multiple variants may run simultaneously (legacy, stable, unstable,
dev, etc.), each on a dedicated port.

When a Kunobi variant connects, its tools are registered here with a prefixed
name: e.g. a tool "get_pod_logs" from the "dev" variant appears as
"dev/get_pod_logs". Tools appear and disappear dynamically as Kunobi variants
start and stop.

If Kunobi is not installed, it can be downloaded from
https://kunobi.ninja/downloads

Available hub tools:
- kunobi_status: Check which variants are connected and when the last scan
  occurred. Call this first to understand what's available.
- kunobi_launch: Start the Kunobi desktop app if no variants are detected.
- kunobi_refresh: Force an immediate rescan of all variant ports. Use after
  launching Kunobi or when kunobi_status shows stale data.

Typical workflow:
1. Call kunobi_status to see what's connected
2. If nothing is connected, call kunobi_launch then kunobi_refresh
3. Use the variant-prefixed tools (e.g. stable/get_pod_logs) for operations
```

### 2. Enriched Tool Descriptions

**kunobi_status:**
```
Check which Kunobi variants are currently connected to this hub. Reports each
variant's port, connection status, available tools, and when the last scan
occurred. Call this before using Kunobi tools to understand what's available.
```

Output adds `Last scanned: Xs ago` line.

**kunobi_launch:**
```
Launch the Kunobi desktop app. Optionally specify a variant (e.g. "Kunobi Dev").
If no variant is specified, launches the first installed one. After launching,
call kunobi_refresh to detect the new instance immediately instead of waiting
for the next automatic scan.
```

**kunobi_refresh (new):**
```
Force an immediate rescan of all Kunobi variant ports. Use this after launching
Kunobi or when kunobi_status shows stale data. Returns the fresh connection
status for all variants.
```

### 3. Scanner Changes

- Make `scan()` public so it can be called on demand
- Track `lastScanTime` as a timestamp, expose via `getLastScanTime()`

### 4. Minor Prompt Updates

Update `kunobi-setup` and `kunobi-doctor` prompts to mention `kunobi_refresh`.

## Files Changed

| File | Change |
|---|---|
| `src/server.ts` | Add `instructions`, register `kunobi_refresh` tool |
| `src/tools/status.ts` | Enrich description, add last-scanned timestamp |
| `src/tools/launch.ts` | Enrich description to mention kunobi_refresh |
| `src/scanner.ts` | Make `scan()` public, add `lastScanTime` tracking |
| Tests | Update expectations, add refresh tool tests |
