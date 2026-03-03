import { writeFileSync } from 'node:fs';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import type React from 'react';
import { useState } from 'react';
import { DEFAULT_CONFIG_PATH, loadConfig, type McpConfig } from '../config.js';

export function ConfigView(): React.ReactElement {
  const [config, setConfig] = useState<McpConfig>(() =>
    loadConfig(DEFAULT_CONFIG_PATH),
  );
  const [mode, setMode] = useState<'view' | 'add-name' | 'add-port' | 'delete'>(
    'view',
  );
  const [newName, setNewName] = useState('');
  const [newPort, setNewPort] = useState('');
  const [message, setMessage] = useState('');

  const entries = Object.entries(config.variants).sort(([, a], [, b]) => a - b);

  const saveConfig = (updated: McpConfig) => {
    writeFileSync(DEFAULT_CONFIG_PATH, `${JSON.stringify(updated, null, 2)}\n`);
    setConfig(updated);
  };

  useInput((input) => {
    if (mode !== 'view') return;
    if (input === 'a') {
      setMode('add-name');
      setNewName('');
      setNewPort('');
      setMessage('');
    }
    if (input === 'd') {
      setMode('delete');
      setNewName('');
      setMessage('');
    }
  });

  return (
    <Box flexDirection="column">
      <Text bold>Configuration</Text>
      <Text dimColor>{'─'.repeat(50)}</Text>
      <Text dimColor>File: {DEFAULT_CONFIG_PATH}</Text>
      <Box flexDirection="column" marginTop={1}>
        {entries.map(([name, port]) => (
          <Box key={name} gap={1}>
            <Text>{name.padEnd(12)}</Text>
            <Text dimColor>→</Text>
            <Text color="cyan">{port}</Text>
          </Box>
        ))}
      </Box>
      <Box marginTop={1}>
        {mode === 'view' && (
          <Text dimColor>[a] add variant [d] delete variant</Text>
        )}
        {mode === 'add-name' && (
          <Box gap={1}>
            <Text>Variant name: </Text>
            <TextInput
              value={newName}
              onChange={setNewName}
              onSubmit={() => setMode('add-port')}
            />
          </Box>
        )}
        {mode === 'add-port' && (
          <Box gap={1}>
            <Text>Port for &quot;{newName}&quot;: </Text>
            <TextInput
              value={newPort}
              onChange={setNewPort}
              onSubmit={() => {
                const port = Number(newPort);
                if (!newName || Number.isNaN(port)) {
                  setMessage('Invalid name or port');
                  setMode('view');
                  return;
                }
                const updated = {
                  variants: { ...config.variants, [newName]: port },
                };
                saveConfig(updated);
                setMessage(`Added ${newName}:${port}`);
                setMode('view');
              }}
            />
          </Box>
        )}
        {mode === 'delete' && (
          <Box gap={1}>
            <Text>Delete variant name: </Text>
            <TextInput
              value={newName}
              onChange={setNewName}
              onSubmit={() => {
                const { [newName]: _, ...rest } = config.variants;
                if (
                  Object.keys(rest).length ===
                  Object.keys(config.variants).length
                ) {
                  setMessage(`"${newName}" not found`);
                } else {
                  saveConfig({ variants: rest });
                  setMessage(`Removed ${newName}`);
                }
                setNewName('');
                setMode('view');
              }}
            />
          </Box>
        )}
      </Box>
      {message && <Text color="green">{message}</Text>}
    </Box>
  );
}
