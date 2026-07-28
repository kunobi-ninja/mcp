import { createHash } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

const DIRECT_MAX = 64; // conservative cross-client ceiling (Claude/OpenAI)
const SLUG_MAX = 12;

function slugify(name: string): string {
  const cleaned = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
  if (!cleaned) return 'proxy';
  // Build up word-by-word so we never cut a word in half; a single word
  // longer than SLUG_MAX still gets hard-truncated as a fallback.
  let result = '';
  for (const word of cleaned.split('_')) {
    const candidate = result ? `${result}_${word}` : word;
    if (candidate.length > SLUG_MAX) break;
    result = candidate;
  }
  return result || cleaned.slice(0, SLUG_MAX) || 'proxy';
}

export function proxyToolPrefix(
  variant: string,
  name: string,
  uuid: string,
): string {
  const hash6 = createHash('sha256').update(uuid).digest('hex').slice(0, 6);
  return `${variant}__agw_${slugify(name)}_${hash6}__`;
}

export function namespacedToolName(
  prefix: string,
  originalTool: string,
): string {
  return `${prefix}${originalTool}`;
}

type ServerInternals = { _registeredTools?: Record<string, unknown> };

export function classifyRegistration(
  server: McpServer,
  name: string,
): 'register' | 'callable_only' {
  const registered =
    (server as unknown as ServerInternals)._registeredTools ?? {};
  if (name.length > DIRECT_MAX) return 'callable_only';
  if (name in registered) return 'callable_only';
  return 'register';
}
