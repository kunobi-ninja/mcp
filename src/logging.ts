import type { LoggingLevel } from '@modelcontextprotocol/sdk/types.js';

// A failed attempt to (re)connect to a variant's port is expected operation for
// this hub, not a client-actionable error: the hub is designed for Kunobi
// variants that come and go, it retries forever, and it already reports an
// absent variant as `not_running` (see VariantManager.getStates). The bundler,
// however, logs these connection-establishment failures at `error`, so they
// reach the MCP client looking like something broke when nothing did — the app
// simply isn't running. Match those messages so we can route them to `debug`.
//
// Note this is deliberately limited to connection failures. Errors raised while
// a variant IS connected (e.g. "Failed to list tools", "Tool call failed") are
// genuine and must still surface at `error`.
function isExpectedConnectFailure(message: string): boolean {
  return (
    message.includes('Transport error') || message.includes('Connection failed')
  );
}

// Map a bundler log (level, message) to the MCP logging level the hub should
// emit, or `null` to drop it. Mirrors the previous inline behaviour — only
// `error`/`warn` are surfaced to the client — with one change: expected
// variant-connection failures are downgraded from `error` to `debug` so they
// stop masquerading as failures. The connection state itself stays observable
// via the `kunobi://status` resource and the `kunobi_status` tool.
export function classifyBundlerLog(
  level: string,
  message: string,
): LoggingLevel | null {
  if (level === 'error') {
    return isExpectedConnectFailure(message) ? 'debug' : 'error';
  }
  if (level === 'warn') {
    return 'warning';
  }
  return null;
}
