import { defineConfig } from 'tsup'

export default defineConfig({
  // Bundle the runtime dependencies so the .mcpb package needs no
  // node_modules next to dist/index.js.
  noExternal: [/^@modelcontextprotocol\/sdk/, /^@modelcontextprotocol\/ext-apps/, /^zod/],
  banner: { js: '#!/usr/bin/env node' },
})
