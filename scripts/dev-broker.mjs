#!/usr/bin/env node
/** Dev-only stub of the Tauri host integration broker (contract section 3).
 *
 * The bridge probes BOTH the backend and the host broker before every tool
 * call, so driving it without the desktop app needs something answering the
 * broker routes. This script provides that, and writes the matching discovery
 * file, so a bare `stript serve` is enough to exercise the whole loop.
 *
 * It is a TEST FIXTURE, never shipped: the permits it returns are placeholders
 * that only a non-frozen dev backend accepts (a frozen sidecar verifies the
 * real Ed25519 envelope and rejects these). Metering therefore proves nothing
 * here; that is what the staged frozen build is for.
 *
 * Usage:
 *   node scripts/dev-broker.mjs [--backend-port 8000] [--token t2]
 *
 * Ctrl-C removes the discovery file it wrote.
 */

import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const backendPort = Number.parseInt(arg('backend-port', '8000'), 10)
const token = arg('token', 't2')
const dataDir = path.resolve(
  process.env.STRIPT_DATA_DIR ?? path.join(os.homedir(), '.stript'),
)
const discoveryPath = path.join(dataDir, 'integration.json')

// Never clobber a discovery file a real Stript app is using.
if (fs.existsSync(discoveryPath)) {
  try {
    const existing = JSON.parse(fs.readFileSync(discoveryPath, 'utf8'))
    if (existing.app_version !== 'dev-stub') {
      console.error(
        `Refusing to overwrite ${discoveryPath} (app_version ${existing.app_version}).\n` +
          'A real Stript app looks active. Disable AI integrations in Settings, or quit it, then retry.',
      )
      process.exit(1)
    }
  } catch {
    console.error(`Refusing to overwrite unreadable ${discoveryPath}. Remove it manually.`)
    process.exit(1)
  }
}

function send(res, status, body) {
  if (body === undefined) return res.writeHead(status).end()
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

const server = http.createServer((req, res) => {
  if (req.headers['x-stript-integration-token'] !== token) {
    return send(res, 401, { error: 'invalid token' })
  }
  const url = req.url ?? ''
  if (req.method === 'GET' && url === '/v1/info') {
    return send(res, 200, { protocol: 1, app_version: 'dev-stub' })
  }
  let body = ''
  req.on('data', (chunk) => {
    body += chunk
  })
  req.on('end', () => {
    if (req.method === 'POST' && url === '/v1/permit') {
      console.error(`[dev-broker] permit requested: ${body}`)
      return send(res, 200, { permit: 'dev-stub-permit' })
    }
    if (req.method === 'POST' && url === '/v1/finalize') {
      console.error('[dev-broker] receipt finalized')
      return send(res, 200, { native_reservation_id: 'dev-stub-reservation' })
    }
    if (req.method === 'POST' && url === '/v1/open-document') {
      console.error(
        `[dev-broker] open-document ignored (no app window in this mode): ${body}`,
      )
      return send(res, 204)
    }
    send(res, 404, { error: 'not found' })
  })
})

server.listen(0, '127.0.0.1', () => {
  const { port } = server.address()
  fs.mkdirSync(dataDir, { recursive: true })
  fs.writeFileSync(
    discoveryPath,
    JSON.stringify({
      version: 1,
      app_version: 'dev-stub',
      backend_port: backendPort,
      broker_port: port,
      token,
    }),
    { mode: 0o600 },
  )
  console.error(`[dev-broker] listening on 127.0.0.1:${port}`)
  console.error(`[dev-broker] wrote ${discoveryPath} (backend port ${backendPort})`)
  console.error('[dev-broker] review mode will not open a window in this mode')
  console.error('[dev-broker] Ctrl-C to stop and remove the discovery file')
})

function cleanup() {
  try {
    const existing = JSON.parse(fs.readFileSync(discoveryPath, 'utf8'))
    if (existing.app_version === 'dev-stub') fs.unlinkSync(discoveryPath)
  } catch {
    // already gone or not ours
  }
  process.exit(0)
}
process.on('SIGINT', cleanup)
process.on('SIGTERM', cleanup)
