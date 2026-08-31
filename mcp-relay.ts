import { MCP_RELAY_ERROR, runMcpRelay } from './src/mcp/stdio-relay.ts';

try {
  await runMcpRelay(process.argv.slice(2), {
    input: process.stdin,
    output: process.stdout,
  });
} catch {
  process.exitCode = 1;
  process.stderr.write(MCP_RELAY_ERROR);
}
