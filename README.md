# @kunobi/mcp

MCP bridge to [Kunobi](https://kunobi.ninja), a desktop platform management IDE. AI assistants manage Kubernetes, FluxCD, ArgoCD, and Helm while users maintain real-time visual oversight.

![Kunobi](assets/main.png)

## What is Kunobi?

[Kunobi](https://kunobi.ninja) is a desktop IDE for platform engineering — built with Rust and React, no Electron.

- Real-time cluster visibility with resource browser, YAML editor, and embedded terminal
- Native FluxCD, ArgoCD, and Helm support
- Built-in MCP server for AI assistants (Claude Code, Cursor, Windsurf, Codex CLI, Gemini CLI)
- Available on macOS, Windows, and Linux
- No account required, no cloud dependency

![Kunobi — Cluster view](assets/nodes.png)

## Setup

Enable MCP in Kunobi under **Settings > AI & MCP**, then install:

![Kunobi — MCP settings](assets/mcp.png)

### Automatic (recommended)

Register with all your AI clients in one step:

```bash
npx @kunobi/mcp --install
```

This interactively detects your installed AI clients and registers the server with them. Supported clients:

- **Claude Code** — project or user scope
- **Claude Desktop** — user scope
- **Cursor** — project or user scope
- **Windsurf** — project or user scope
- **Codex CLI** — project or user scope
- **Gemini CLI** — project or user scope

To remove the server from all clients:

```bash
npx @kunobi/mcp --uninstall
```

### Manual

If you prefer manual setup, add the following to your client's MCP config:

```json
{
  "mcpServers": {
    "kunobi": {
      "command": "npx",
      "args": ["-y", "@kunobi/mcp"]
    }
  }
}
```

## How it works

```
AI assistant <--stdio--> @kunobi/mcp <--HTTP--> Kunobi variants
                          │
                          ├── scans ports every 5s
                          ├── confirms Kunobi identity via serverInfo
                          └── manages one bundler per variant
```

The server periodically probes known ports for running Kunobi instances. When a variant is detected, its tools are registered with a `variant/` prefix (e.g., `dev/list_clusters`, `stable/query_store`). When a variant stops, its tools are automatically removed.

### Multi-variant support

Kunobi ships multiple release channels that run on different ports. This MCP server discovers all of them simultaneously:

| Variant  | Port | Tool prefix   |
|----------|------|---------------|
| legacy   | 3030 | `legacy/`     |
| stable   | 3200 | `stable/`     |
| unstable | 3300 | `unstable/`   |
| dev      | 3400 | `dev/`        |
| local    | 3500 | `local/`      |
| e2e      | 3600 | `e2e/`        |

### Built-in tools

These are always available, even when no Kunobi instance is running:

- **`kunobi_status`** — reports all variant connection states, ports, and tool counts
- **`kunobi_launch`** — launches a Kunobi variant by name

### Dynamic tools

When a Kunobi variant is detected, its tools appear automatically with a variant prefix. For example, if `dev` and `stable` are both running:

- `dev/app_info`, `dev/query_store`, `dev/list_stores`, ...
- `stable/app_info`, `stable/query_store`, `stable/list_stores`, ...

Tools appear and disappear dynamically as variants start and stop — no MCP server restart needed.

## Configuration

| Env var | Default | Description |
|---------|---------|-------------|
| `MCP_KUNOBI_INTERVAL` | `5000` | Scan interval in ms |
| `MCP_KUNOBI_PORTS` | all known | Comma-separated port filter (e.g., `3400,3500`) |
| `MCP_KUNOBI_ENABLED` | `true` | Set `false` to disable scanning |
| `MCP_KUNOBI_MISS_THRESHOLD` | `3` | Consecutive scan misses before removing a variant |

No configuration is required. The server scans all known ports automatically.

## CLI

```
npx @kunobi/mcp [option]
```

| Option | Description |
|--------|-------------|
| `--install`, `-i` | Register this MCP server with your AI clients |
| `--uninstall`, `-u` | Remove this MCP server from your AI clients |
| `--help`, `-h` | Show help message |
| `--version`, `-v` | Show version number |
| *(no option)* | Start the stdio MCP server (used by AI clients) |

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

## License

[Apache-2.0](LICENSE)
