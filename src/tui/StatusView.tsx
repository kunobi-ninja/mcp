import { Box, Text } from 'ink';
import type React from 'react';
import { useEffect, useState } from 'react';
import { DEFAULT_CONFIG_PATH, loadConfig } from '../config.js';
import { probeKunobiServer } from '../discovery.js';

interface VariantStatus {
  name: string;
  port: number;
  status: 'checking' | 'connected' | 'not_detected';
  tools: string[];
}

export function StatusView(): React.ReactElement {
  const [variants, setVariants] = useState<VariantStatus[]>([]);
  const [scanning, setScanning] = useState(true);

  useEffect(() => {
    const config = loadConfig(DEFAULT_CONFIG_PATH);
    const entries = Object.entries(config.variants);

    setVariants(
      entries.map(([name, port]) => ({
        name,
        port,
        status: 'checking',
        tools: [],
      })),
    );

    Promise.all(
      entries.map(async ([name, port]) => {
        const result = await probeKunobiServer(`http://127.0.0.1:${port}/mcp`);
        return {
          name,
          port,
          status: (result ? 'connected' : 'not_detected') as
            | 'connected'
            | 'not_detected',
          tools: result?.tools ?? [],
        };
      }),
    ).then((results) => {
      setVariants(results);
      setScanning(false);
    });
  }, []);

  return (
    <Box flexDirection="column">
      <Text bold>Variant Status</Text>
      <Text dimColor>{'─'.repeat(50)}</Text>
      {variants.map((v) => (
        <Box key={v.name} gap={1}>
          <Text
            color={
              v.status === 'connected'
                ? 'green'
                : v.status === 'checking'
                  ? 'yellow'
                  : 'red'
            }
          >
            {v.status === 'connected'
              ? '●'
              : v.status === 'checking'
                ? '○'
                : '✗'}
          </Text>
          <Text>{v.name.padEnd(12)}</Text>
          <Text dimColor>port {v.port}</Text>
          {v.status === 'connected' && (
            <Text color="green">{v.tools.length} tools</Text>
          )}
        </Box>
      ))}
      {scanning && <Text color="yellow">Scanning...</Text>}
    </Box>
  );
}
