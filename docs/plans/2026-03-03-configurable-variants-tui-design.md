# Configurable Variant Ports + TUI Dashboard

**Date:** 2026-03-03
**Status:** Approved

## Problem

Variant→port mappings are hardcoded in `src/discovery.ts`. Coworkers running Kunobi on custom ports are invisible to the hub. There's no way to add, view, or manage variant configurations without editing source code.

## Solution

Three components:

1. **Config file** (`~/.config/kunobi/mcp.json`) — persistent source of truth for variant ports
2. **Env var merge** — `MCP_KUNOBI_PORTS` adds/overrides entries at runtime
3. **TUI dashboard** (ink) — interactive terminal UI for config, status, and installation

## Design

### 1. Config File

**Location:** `~/.config/kunobi/mcp.json`

**Auto-generated** on first run with the current hardcoded defaults:

```json
{
  "variants": {
    "legacy": 3030,
    "stable": 3200,
    "unstable": 3300,
    "dev": 3400,
    "local": 3500,
    "e2e": 3600
  }
}
```

Users edit this file to add custom variants:

```json
{
  "variants": {
    "legacy": 3030,
    "stable": 3200,
    "unstable": 3300,
    "dev": 3400,
    "local": 3500,
    "e2e": 3600,
    "juan": 4200
  }
}
```

**Module:** New `src/config.ts` handles read/write/auto-generate.

### 2. Env Var Merge

`MCP_KUNOBI_PORTS` changes from port-only filter to `name:port` merge format:

```
MCP_KUNOBI_PORTS="juan:4200,test:5000"
```

**Backward compat:** If values are bare numbers (e.g., `3400,3500`), treat as a port-only filter (current behavior).

**Priority chain:**
```
hardcoded defaults → config file → env var (wins on conflict)
```

### 3. TUI Dashboard (ink)

**Entry point:** Auto-detect TTY.

- Interactive terminal (TTY) → show TUI
- Piped stdin (MCP client) → start MCP server (current behavior)
- Explicit flags (`--install`, `--help`, etc.) → current behavior unchanged

**TUI sections:**

| Section | Description |
|---------|-------------|
| **Status** | Live view of all variant connection states, ports, tool counts |
| **Config** | View/add/remove/edit variant port mappings, saves to config file |
| **Install** | Register/unregister MCP server with AI clients (wraps `--install`/`--uninstall`) |

**Library:** `ink` (React for terminal) + `ink-text-input` for editing.

### 4. `kunobi_status` Enhancement

The MCP tool now shows all **configured** variants (including disconnected ones) with their ports, making the full config visible to AI clients.

## Files

| File | Action | Description |
|------|--------|-------------|
| `src/config.ts` | New | Config file read/write/auto-generate |
| `src/discovery.ts` | Modify | `getScanConfig()` reads config file + merges env var |
| `src/server.ts` | Modify | TTY detection: TUI vs MCP server mode |
| `src/tui/App.tsx` | New | Ink root component |
| `src/tui/StatusView.tsx` | New | Live variant status dashboard |
| `src/tui/ConfigView.tsx` | New | Config editor (add/remove/edit variants) |
| `src/tui/InstallView.tsx` | New | Install/uninstall MCP server |
| `src/tools/status.ts` | Modify | Show all configured variants |
| `package.json` | Modify | Add `ink`, `react`, `ink-text-input` dependencies |
| `tsconfig.json` | Modify | Enable JSX for ink components |
| `rollup.config.mjs` | Modify | Handle JSX/TSX files |

## Non-Goals

- No runtime `kunobi_add_variant` MCP tool (config file is manual edit)
- No hot-reload of config file (requires MCP server restart)
- No per-variant scan interval or miss threshold overrides
