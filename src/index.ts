/** stdio entry point for the Stript MCP bridge.
 *
 * stdout carries the MCP protocol, so nothing in this process may ever
 * console.log. Fatal diagnostics go to stderr only.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

import { loadConfig } from './config.js'
import { buildServer } from './server.js'

async function main(): Promise<void> {
  const config = loadConfig()
  const server = buildServer(config)
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`stript-mcp failed to start: ${message}`)
  process.exit(1)
})
