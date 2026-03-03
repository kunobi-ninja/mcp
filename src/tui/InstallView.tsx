import { Box, Text, useInput } from 'ink';
import type React from 'react';
import { useState } from 'react';

export function InstallView(): React.ReactElement {
  const [status, setStatus] = useState<string>('');
  const [busy, setBusy] = useState(false);

  useInput(async (input) => {
    if (busy) return;
    if (input === 'i') {
      setBusy(true);
      setStatus('Installing...');
      try {
        const { install } = await import('@kunobi/mcp-installer');
        await install({
          name: 'kunobi',
          command: 'npx',
          args: ['-y', '@kunobi/mcp'],
        });
        setStatus(
          'Installed successfully! Restart your AI client to pick it up.',
        );
      } catch (err) {
        setStatus(`Install failed: ${err}`);
      }
      setBusy(false);
    }
    if (input === 'u') {
      setBusy(true);
      setStatus('Uninstalling...');
      try {
        const { uninstall } = await import('@kunobi/mcp-installer');
        await uninstall({ name: 'kunobi' });
        setStatus('Uninstalled successfully.');
      } catch (err) {
        setStatus(`Uninstall failed: ${err}`);
      }
      setBusy(false);
    }
  });

  return (
    <Box flexDirection="column">
      <Text bold>MCP Server Registration</Text>
      <Text dimColor>{'─'.repeat(50)}</Text>
      <Text>Register or remove this MCP server from your AI clients</Text>
      <Text>(Claude Code, Cursor, Windsurf, etc.)</Text>
      <Box marginTop={1} gap={2}>
        <Text color={busy ? 'gray' : 'green'}>[i] Install</Text>
        <Text color={busy ? 'gray' : 'red'}>[u] Uninstall</Text>
      </Box>
      {status && (
        <Box marginTop={1}>
          <Text>{status}</Text>
        </Box>
      )}
    </Box>
  );
}
