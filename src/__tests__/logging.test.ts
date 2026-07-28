import { describe, expect, it } from 'vitest';
import { classifyBundlerLog } from '../logging.js';

describe('classifyBundlerLog', () => {
  it('downgrades expected variant-connection failures to debug', () => {
    // These fire when a variant port is closed (the Kunobi app isn't running),
    // which is normal for this hub — they must not reach the client as errors.
    expect(classifyBundlerLog('error', '[legacy] Transport error')).toBe(
      'debug',
    );
    expect(classifyBundlerLog('error', '[dev] Connection failed')).toBe(
      'debug',
    );
  });

  it('keeps genuine errors from a connected variant at error', () => {
    expect(classifyBundlerLog('error', '[stable] Failed to list tools')).toBe(
      'error',
    );
    expect(
      classifyBundlerLog('error', '[stable] Tool call failed: get_pod_logs'),
    ).toBe('error');
    expect(
      classifyBundlerLog('error', '[stable] Resource read failed: kunobi://x'),
    ).toBe('error');
  });

  it('maps warn to warning', () => {
    expect(
      classifyBundlerLog('warn', '[stable] Session expired. Reconnecting.'),
    ).toBe('warning');
  });

  it('downgrades expected proxy-catalog poll traffic to debug at any level', () => {
    // Older variants don't serve `kunobi://mcp-proxies`; the hub polls it every
    // interval, and the unchanged bundler logs the failed read at error (and a
    // session-expired retry at warn). Neither is client-actionable — the
    // registry fails closed — so a mixed-version setup must not be spammed.
    expect(
      classifyBundlerLog(
        'error',
        '[legacy] Resource read failed: kunobi://mcp-proxies',
      ),
    ).toBe('debug');
    expect(
      classifyBundlerLog(
        'warn',
        '[legacy] Session expired while reading kunobi://mcp-proxies',
      ),
    ).toBe('debug');
  });

  it('still surfaces genuine read failures of OTHER resources at error', () => {
    // The downgrade is scoped to the proxy-catalog URI only — a failed read of
    // any other resource is a real error and must reach the client.
    expect(
      classifyBundlerLog(
        'error',
        '[stable] Resource read failed: kunobi://status',
      ),
    ).toBe('error');
  });

  it('drops info/debug and any other level', () => {
    expect(classifyBundlerLog('info', '[stable] Connected')).toBeNull();
    expect(classifyBundlerLog('debug', 'anything')).toBeNull();
  });
});
