import { Box, Text } from 'ink';
import type React from 'react';

export function App(): React.ReactElement {
  return (
    <Box flexDirection="column" padding={1}>
      <Text bold color="cyan">
        Kunobi MCP
      </Text>
      <Text dimColor>{'─'.repeat(50)}</Text>
      <Text>Loading...</Text>
    </Box>
  );
}
