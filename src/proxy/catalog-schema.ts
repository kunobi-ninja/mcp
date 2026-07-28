import type { ReadResourceResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

export const CATALOG_SCHEMA_VERSION = 1;

export const CatalogProxySchema = z.object({
  uuid: z.string().min(1),
  name: z.string(),
  port: z.number().int().positive(),
  incarnation: z.string().min(1),
});

export const CatalogSchema = z.object({
  schemaVersion: z.number().int(),
  proxies: z.array(CatalogProxySchema),
});

export type Catalog = z.infer<typeof CatalogSchema>;
export type CatalogProxy = z.infer<typeof CatalogProxySchema>;

/** Discriminated read outcome derived from an unchanged bundler (see spec
 *  "Observability caveat"): a valid parse is authoritative; a valid parse with an
 *  unsupported version is an authoritative revoke; anything else is transient. */
export type ReadOutcome =
  | { kind: 'present'; catalog: Catalog }
  | { kind: 'revoke' } // valid parse, unsupported schemaVersion
  | { kind: 'unavailable' }; // error text / malformed / not connected

export function classifyRead(res: ReadResourceResult | null): ReadOutcome {
  if (!res) return { kind: 'unavailable' };
  const text =
    res.contents?.[0] && 'text' in res.contents[0]
      ? (res.contents[0] as { text?: string }).text
      : undefined;
  if (typeof text !== 'string') return { kind: 'unavailable' };
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { kind: 'unavailable' };
  }
  const parsed = CatalogSchema.safeParse(json);
  if (!parsed.success) {
    // A well-formed object with a version field but wrong shape/version → revoke;
    // otherwise treat as transient. Distinguish by a present numeric schemaVersion.
    const v = (json as { schemaVersion?: unknown })?.schemaVersion;
    if (typeof v === 'number' && v !== CATALOG_SCHEMA_VERSION)
      return { kind: 'revoke' };
    return { kind: 'unavailable' };
  }
  if (parsed.data.schemaVersion !== CATALOG_SCHEMA_VERSION)
    return { kind: 'revoke' };
  return { kind: 'present', catalog: parsed.data };
}
