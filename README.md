# @kunobi/mcp

MCP server for [Kunobi](https://kunobi.ninja). Runs as a stdio server and auto-discovers multiple Kunobi instances across variant-specific ports, exposing their tools to AI assistants with `variant/` prefixed namespacing.

## Setup

```json
{
  "mcpServers": {
    "kunobi": {
      "command": "npx",
      "args": ["@kunobi/mcp"]
    }
  }
}
```

## How it works

```
Claude Code <--stdio--> @kunobi/mcp <--HTTP--> Kunobi variants
                          │
                          ├── scans ports every 5s
                          ├── confirms Kunobi identity via serverInfo
                          └── manages one bundler per variant
```

The server periodically probes known ports for running Kunobi instances. When a variant is detected, its tools are registered with a `variant/` prefix (e.g., `dev/list_clusters`, `stable/query_store`). When a variant stops, its tools are automatically removed.

### Port map

| Variant  | Port | Tool prefix   |
|----------|------|---------------|
| legacy   | 3030 | `legacy/`     |
| stable   | 3200 | `stable/`     |
| unstable | 3300 | `unstable/`   |
| dev      | 3400 | `dev/`        |
| local    | 3500 | `local/`      |
| e2e      | 3600 | `e2e/`        |

### Built-in tools

- **`kunobi_status`** — reports all variant connection states, ports, and tool counts
- **`kunobi_launch`** — launches a Kunobi variant by name

## Configuration

| Env var | Default | Description |
|---------|---------|-------------|
| `KUNOBI_SCAN_INTERVAL` | `5000` | Scan interval in ms |
| `KUNOBI_SCAN_PORTS` | all known | Comma-separated port filter (e.g., `3400,3500`) |
| `KUNOBI_SCAN_ENABLED` | `true` | Set `false` to disable scanning |
| `KUNOBI_SCAN_MISS_THRESHOLD` | `3` | Consecutive scan misses before removing a variant |

No configuration is required. The server scans all known ports automatically.

## Development

```bash
pnpm install
pnpm build
pnpm test
```

For local development against `@kunobi/mcp-bundler`:

```bash
pnpm dev:link    # link local bundler
pnpm dev:unlink  # revert to npm version
```
