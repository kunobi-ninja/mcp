import { Box, Text, useInput } from 'ink';
import type React from 'react';
import { useState } from 'react';
import { ConfigView } from './ConfigView.js';
import { InstallView } from './InstallView.js';
import { StatusView } from './StatusView.js';

type Tab = 'status' | 'config' | 'install';

export function App(): React.ReactElement {
  const [tab, setTab] = useState<Tab>('status');

  useInput((input, key) => {
    if (input === '1') setTab('status');
    if (input === '2') setTab('config');
    if (input === '3') setTab('install');
    if (key.escape || (input === 'q' && tab === 'status')) process.exit(0);
  });

  return (
    <Box flexDirection="column" padding={1}>
      <Text bold color="cyan">
        Kunobi MCP
      </Text>
      <Box gap={2}>
        <Text
          bold={tab === 'status'}
          color={tab === 'status' ? 'cyan' : undefined}
        >
          [1] Status
        </Text>
        <Text
          bold={tab === 'config'}
          color={tab === 'config' ? 'cyan' : undefined}
        >
          [2] Config
        </Text>
        <Text
          bold={tab === 'install'}
          color={tab === 'install' ? 'cyan' : undefined}
        >
          [3] Install
        </Text>
      </Box>
      <Text dimColor>{'─'.repeat(50)}</Text>
      <Box marginTop={1}>
        {tab === 'status' && <StatusView />}
        {tab === 'config' && <ConfigView />}
        {tab === 'install' && <InstallView />}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>[1-3] switch tabs [q/Esc] quit</Text>
      </Box>
    </Box>
  );
}
