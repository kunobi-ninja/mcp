import { DEFAULT_CONFIG_PATH, loadConfig, saveConfig } from './config.js';
import { inspectKunobiServer } from './discovery.js';

export async function runList(): Promise<void> {
  const config = loadConfig();
  const entries = Object.entries(config.variants).sort(([, a], [, b]) => a - b);

  console.log('Kunobi MCP — Configured Variants');
  console.log('─'.repeat(45));

  const results = await Promise.all(
    entries.map(async ([name, port]) => {
      const result = await inspectKunobiServer(`http://127.0.0.1:${port}/mcp`);
      return {
        name,
        port,
        connected: result !== null,
        tools: result?.tools.length ?? 0,
      };
    }),
  );

  for (const { name, port, connected, tools } of results) {
    const status = connected
      ? `\x1b[32m● connected (${tools} tools)\x1b[0m`
      : '\x1b[90m○ not running\x1b[0m';
    console.log(`  ${name.padEnd(12)} :${String(port).padEnd(6)} ${status}`);
  }

  console.log(`\nConfig: ${DEFAULT_CONFIG_PATH}`);
}

export function runAdd(name: string, port: number): void {
  const config = loadConfig();

  if (config.variants[name] !== undefined) {
    console.log(`Updating "${name}": ${config.variants[name]} → ${port}`);
  } else {
    console.log(`Adding "${name}" on port ${port}`);
  }

  config.variants[name] = port;
  saveConfig(config);
  console.log(`Saved to ${DEFAULT_CONFIG_PATH}`);
}

export function runRemove(name: string): void {
  const config = loadConfig();

  if (config.variants[name] === undefined) {
    console.error(`Variant "${name}" not found.`);
    console.error(`Available: ${Object.keys(config.variants).join(', ')}`);
    process.exit(1);
  }

  const { [name]: _, ...rest } = config.variants;
  saveConfig({ variants: rest });
  console.log(`Removed "${name}". Saved to ${DEFAULT_CONFIG_PATH}`);
}
