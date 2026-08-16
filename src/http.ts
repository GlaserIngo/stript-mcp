/** Transport-agnostic Streamable-HTTP mount for the future remote variant
 * (Docker self-hosted Stript as a ChatGPT Business connector). Compile
 * checked and exported, deliberately NOT wired into the stdio entry. */

import type { IncomingMessage, ServerResponse } from 'node:http'

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'

export interface HttpMount {
  transport: StreamableHTTPServerTransport
  /** Delegate an incoming HTTP request to the MCP transport. */
  handleRequest: (req: IncomingMessage, res: ServerResponse, parsedBody?: unknown) => Promise<void>
}

/** Connect the given server to a stateless Streamable-HTTP transport. The
 * caller owns the HTTP listener and routes requests into handleRequest. */
export async function mountStreamableHttp(server: McpServer): Promise<HttpMount> {
  const transport = new StreamableHTTPServerTransport({
    // Stateless mode: no session ids, every request self-contained.
    sessionIdGenerator: undefined,
  })
  await server.connect(transport)
  return {
    transport,
    handleRequest: (req, res, parsedBody) => transport.handleRequest(req, res, parsedBody),
  }
}
