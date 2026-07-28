import { describe, expect, it } from 'vitest';
import {
  classifyRegistration,
  namespacedToolName,
  proxyToolPrefix,
} from '../proxy/namespace.js';

describe('proxy/namespace', () => {
  it('builds a compact sanitized hashed prefix', () => {
    expect(
      proxyToolPrefix(
        'dev',
        'Kunobi MCP Proxy!!',
        '6c62aa00-0000-0000-0000-000000000000',
      ),
    ).toMatch(/^dev__agw_kunobi_mcp_[0-9a-f]{6}__$/);
  });
  it('same name + different uuid → different prefix', () => {
    expect(proxyToolPrefix('dev', 'X', 'uuid-a')).not.toEqual(
      proxyToolPrefix('dev', 'X', 'uuid-b'),
    );
  });
  it('classifies register vs callable_only by length and collision', () => {
    const server = { _registeredTools: { dev__existing: {} } } as any;
    expect(classifyRegistration(server, 'dev__short')).toBe('register');
    expect(classifyRegistration(server, 'dev__existing')).toBe('callable_only'); // collision
    expect(classifyRegistration(server, 'd'.repeat(65))).toBe('callable_only'); // > 64
  });
  it('an agentgateway-target-prefixed original name that overflows 64 is callable_only', () => {
    // realistic double-prefix: dev__agw_<12>_<6>__signoz_query_range_v2_extended...
    const prefix = proxyToolPrefix('unstable', 'Observability Proxy', 'u-1');
    const name = namespacedToolName(
      prefix,
      'signoz_query_range_with_a_long_target_prefix',
    );
    expect(classifyRegistration({ _registeredTools: {} } as any, name)).toBe(
      'callable_only',
    );
  });
});
