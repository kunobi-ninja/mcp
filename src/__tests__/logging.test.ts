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

  it('drops info/debug and any other level', () => {
    expect(classifyBundlerLog('info', '[stable] Connected')).toBeNull();
    expect(classifyBundlerLog('debug', 'anything')).toBeNull();
  });
});
