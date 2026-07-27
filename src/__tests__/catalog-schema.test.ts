import type { ReadResourceResult } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';
import { classifyRead } from '../proxy/catalog-schema.js';

function textResult(text: string): ReadResourceResult {
  return {
    contents: [{ uri: 'kunobi://mcp-proxies', text }],
  };
}

describe('classifyRead', () => {
  it('classifies a null read (not connected) as unavailable', () => {
    expect(classifyRead(null)).toEqual({ kind: 'unavailable' });
  });

  it('classifies a realistic bundler error-text payload as unavailable, not revoke', () => {
    // This is the "Observability caveat" case: the bundler swallows a read
    // failure into opaque error text on `contents[0].text` instead of
    // surfacing a real MCP error. It must be treated as a transient,
    // retryable failure (unavailable) — NOT as an authoritative revoke,
    // which would tear down an otherwise-healthy proxy set on a hiccup.
    const result = textResult(
      '[dev] kunobi://mcp-proxies read failed: upstream socket hang up',
    );
    expect(classifyRead(result)).toEqual({ kind: 'unavailable' });
  });

  it('classifies well-formed JSON with an invalid shape and no numeric schemaVersion as unavailable', () => {
    const result = textResult(JSON.stringify({ proxies: 'not-an-array' }));
    expect(classifyRead(result)).toEqual({ kind: 'unavailable' });
  });

  it('classifies well-formed JSON with an invalid shape but a numeric mismatched schemaVersion as revoke', () => {
    const result = textResult(
      JSON.stringify({ schemaVersion: 2, proxies: 'not-an-array' }),
    );
    expect(classifyRead(result)).toEqual({ kind: 'revoke' });
  });

  it('classifies a valid, current-version catalog as present', () => {
    const result = textResult(
      JSON.stringify({
        schemaVersion: 1,
        proxies: [
          { uuid: 'u1', name: 'agw-proxy', port: 41000, incarnation: 'gen-1' },
        ],
      }),
    );
    expect(classifyRead(result)).toEqual({
      kind: 'present',
      catalog: {
        schemaVersion: 1,
        proxies: [
          { uuid: 'u1', name: 'agw-proxy', port: 41000, incarnation: 'gen-1' },
        ],
      },
    });
  });
});
