import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { loadConfig } from '../src/config.js'

describe('loadConfig allowed directories', () => {
  it('takes directories from argv after --allowed-dirs (the .mcpb path)', () => {
    const config = loadConfig({}, ['--allowed-dirs', '/tmp/a', '/tmp/b'])
    expect(config.allowedDirs).toEqual([path.resolve('/tmp/a'), path.resolve('/tmp/b')])
  })

  it('argv wins over the env variable', () => {
    const env = { STRIPT_MCP_ALLOWED_DIRS: '/tmp/env-only' }
    const config = loadConfig(env, ['--allowed-dirs', '/tmp/argv'])
    expect(config.allowedDirs).toEqual([path.resolve('/tmp/argv')])
  })

  it('falls back to the env variable without the flag', () => {
    const env = { STRIPT_MCP_ALLOWED_DIRS: ['/tmp/x', '/tmp/y'].join(path.delimiter) }
    const config = loadConfig(env, [])
    expect(config.allowedDirs).toEqual([path.resolve('/tmp/x'), path.resolve('/tmp/y')])
  })

  it('ignores a bare flag with no values and uses defaults', () => {
    const config = loadConfig({}, ['--allowed-dirs'])
    expect(config.allowedDirs.length).toBe(3)
  })
})
