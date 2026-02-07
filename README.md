# @kunobi/mcp

MCP server for [Kunobi](https://kunobi.ninja). Runs as a stdio server and connects to Kunobi's built-in HTTP MCP endpoint to expose its tools to AI assistants.

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
Claude Code <--stdio--> @kunobi/mcp <--HTTP--> Kunobi (port 3030)
```

- **Always available:** `kunobi_status` — reports whether Kunobi is installed, running, and reachable
- **Dynamic:** When Kunobi is running with MCP enabled, its tools (`app_info`, `query_store`, `list_stores`, etc.) appear automatically via `notifications/tools/list_changed`
- **Auto-reconnect:** If Kunobi is stopped or restarted, tools disappear and reappear without restarting the MCP server

## Configuration (optional)

| Env var | Default | Description |
|---------|---------|-------------|
| `KUNOBI_MCP_URL` | `http://127.0.0.1:3030/mcp` | Override Kunobi's MCP HTTP endpoint |

No configuration is required. The server connects to Kunobi's default local endpoint automatically.

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
