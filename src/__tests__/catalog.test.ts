import { describe, expect, it } from 'vitest';
import type { ProxySnapshotProvider } from '../catalog.js';
import { buildDiscoveryCatalog } from '../catalog.js';
import type { VariantManager } from '../manager.js';

function emptyProxyRegistry(): ProxySnapshotProvider {
  return { snapshot: () => [] };
}

describe('buildDiscoveryCatalog', () => {
  it('includes full downstream metadata and dynamic names', () => {
    const manager = {
      getCatalog: () =>
        new Map([
          [
            'dev',
            {
              port: 3400,
              status: 'connected' as const,
              tools: [
                {
                  name: 'k8s',
                  title: 'Kubernetes',
                  description: 'Query kubernetes resources',
                  annotations: { readOnlyHint: true },
                  execution: { taskSupport: 'optional' },
                  inputSchema: {
                    type: 'object' as const,
                    properties: {
                      action: { type: 'string', enum: ['list', 'get'] },
                    },
                    required: ['action'],
                  },
                },
              ],
              resources: [
                {
                  uri: 'kunobi://resource/status',
                  name: 'status',
                  description: 'Current status',
                },
              ],
              prompts: [
                {
                  name: 'setup',
                  title: 'Setup',
                  description: 'Setup prompt',
                  arguments: [{ name: 'cluster', required: false }],
                },
              ],
            },
          ],
        ]),
    } as unknown as VariantManager;

    const catalog = buildDiscoveryCatalog(manager, emptyProxyRegistry());
    const dev = catalog.variants.dev as {
      tools: Array<{
        dynamicToolName: string;
        inputSchema: { required?: string[] };
      }>;
      prompts: Array<{ dynamicPromptName: string }>;
      resources: Array<{ uri: string }>;
    };

    expect(catalog.callTool).toBe('kunobi_call');
    expect(dev.tools[0]?.dynamicToolName).toBe('dev__k8s');
    expect(dev.tools[0]?.inputSchema.required).toEqual(['action']);
    expect(dev.prompts[0]?.dynamicPromptName).toBe('dev__setup');
    expect(dev.resources[0]?.uri).toBe('kunobi://resource/status');
    expect(catalog.proxies.entries).toEqual([]);
  });

  it('lists proxy entries with proxy_uuid and per-tool reachability', () => {
    const manager = {
      getCatalog: () => new Map(),
    } as unknown as VariantManager;

    const proxyRegistry: ProxySnapshotProvider = {
      snapshot: () => [
        {
          variant: 'dev',
          uuid: 'u1',
          name: 'signoz',
          tools: [
            {
              originalTool: 'signoz_query_range',
              dynamicToolName: 'ext_signoz_u1__signoz_query_range',
              directlyRegistered: false,
            },
          ],
        },
      ],
    };

    const catalog = buildDiscoveryCatalog(manager, proxyRegistry);

    expect(catalog.proxies.entries).toHaveLength(1);
    expect(catalog.proxies.entries[0]).toEqual({
      variant: 'dev',
      proxy_uuid: 'u1',
      name: 'signoz',
      tools: [
        {
          originalTool: 'signoz_query_range',
          dynamicToolName: 'ext_signoz_u1__signoz_query_range',
          directlyRegistered: false,
        },
      ],
    });
    expect(catalog.proxies.note).toContain('kunobi_call');
    expect(catalog.proxies.note).toContain('directlyRegistered:false');
  });
});
