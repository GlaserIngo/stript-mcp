import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { BackendClient } from '../src/backendClient.js'
import { BrokerClient } from '../src/brokerClient.js'
import type { BridgeConfig } from '../src/config.js'
import { Metering } from '../src/metering.js'
import type { BridgeSession, ToolContext, ToolExtra, ToolTiming } from '../src/tools/shared.js'

export interface RecordedRequest {
  method: string
  url: string
  pathname: string
  headers: http.IncomingHttpHeaders
  body: string
}

export type RouteHandler = (
  req: RecordedRequest,
  res: http.ServerResponse,
) => void | Promise<void>

/** Minimal recording HTTP server for faking the backend and the broker. */
export class FakeServer {
  readonly requests: RecordedRequest[] = []
  private readonly routes = new Map<string, RouteHandler>()
  private server: http.Server | null = null
  port = 0

  route(method: string, pathname: string, handler: RouteHandler): void {
    this.routes.set(`${method} ${pathname}`, handler)
  }

  requestsFor(method: string, pathname: string): RecordedRequest[] {
    return this.requests.filter((r) => r.method === method && r.pathname === pathname)
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}`
  }

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        const parsed = new URL(req.url ?? '/', 'http://127.0.0.1')
        const recorded: RecordedRequest = {
          method: req.method ?? 'GET',
          url: req.url ?? '/',
          pathname: parsed.pathname,
          headers: req.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        }
        this.requests.push(recorded)
        const handler = this.routes.get(`${recorded.method} ${recorded.pathname}`)
        if (handler === undefined) {
          res.writeHead(404, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error_code: 'DOCUMENT_NOT_FOUND', detail: 'not found' }))
          return
        }
        void handler(recorded, res)
      })
    })
    await new Promise<void>((resolve) => {
      this.server?.listen(0, '127.0.0.1', () => resolve())
    })
    this.port = (this.server?.address() as AddressInfo).port
  }

  async stop(): Promise<void> {
    if (this.server === null) return
    // Sever keep-alive sockets, otherwise close() waits for undici's agent
    // to release its pooled connections (about 5 seconds per test).
    this.server.closeAllConnections()
    await new Promise<void>((resolve) => {
      this.server?.close(() => resolve())
    })
    this.server = null
  }
}

export function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

export function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

export function startSse(res: http.ServerResponse): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
  })
}

/** A default backend document payload, spread-overridable per test. */
export function docPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'doc1',
    filename: 'letter.txt',
    mime_type: 'text/plain',
    status: 'uploaded',
    char_count: 100,
    page_count: null,
    created_at: '2026-07-17T00:00:00Z',
    warnings: [],
    credit_status: 'unprocessed',
    metering_commitment: 'commitment-1',
    completion_receipt: null,
    ...overrides,
  }
}

export function licensePayload(remaining: number): Record<string, unknown> {
  return {
    tier: remaining === -1 ? 'pro' : 'free',
    license_key_present: remaining === -1,
    valid: remaining === -1,
    expires_at: null,
    last_validated: null,
    grace_period_active: false,
    usage: {
      documents_processed: remaining === -1 ? 0 : 5 - remaining,
      limit: remaining === -1 ? -1 : 5,
      remaining,
      scope: 'lifetime',
    },
  }
}

export function anonymizePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    document_id: 'doc1',
    project_id: 'default',
    anonymized_text: 'Hello [PERSON_1], your account [IBAN_1] is ready.',
    mapping: [
      { placeholder: '[PERSON_1]', original_text: 'Hans Krassnig', pii_type: 'PERSON', occurrences: 2 },
      { placeholder: '[IBAN_1]', original_text: 'DE44500105175407324931', pii_type: 'IBAN', occurrences: 1 },
    ],
    clusters: [],
    stats: { total_replacements: 3, unique_entities: 2, pii_types_found: ['PERSON', 'IBAN'] },
    completion_receipt: null,
    ...overrides,
  }
}

export const TEST_TOKEN = 'test-token-1'

export function makeSession(backend: FakeServer, broker: FakeServer): BridgeSession {
  const backendClient = new BackendClient(`${backend.url}/api`, TEST_TOKEN)
  const brokerClient = new BrokerClient(`${broker.url}/v1`, TEST_TOKEN)
  return {
    discovery: {
      version: 1,
      app_version: '1.1.0',
      backend_port: backend.port,
      broker_port: broker.port,
      token: TEST_TOKEN,
    },
    backend: backendClient,
    broker: brokerClient,
    metering: new Metering(backendClient, brokerClient),
  }
}

export async function tmpDir(prefix = 'stript-mcp-test-'): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix))
}

export function testConfig(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
  return {
    allowedDirs: [],
    outputDir: path.join(os.tmpdir(), 'stript-mcp-out-unset'),
    enableClipboard: false,
    defaultProject: 'default',
    reviewTimeoutSeconds: 600,
    dataDir: path.join(os.tmpdir(), 'stript-mcp-data-unset'),
    ...overrides,
  }
}

export function makeContext(
  session: BridgeSession,
  config: BridgeConfig,
  timing?: ToolTiming,
): ToolContext {
  const ctx: ToolContext = { config, connect: async () => session }
  if (timing !== undefined) ctx.timing = timing
  return ctx
}

export interface RecordedNotification {
  method: string
  params: Record<string, unknown>
}

export function fakeExtra(notifications: RecordedNotification[] = []): ToolExtra {
  return {
    signal: new AbortController().signal,
    requestId: 1,
    sendNotification: async (notification: unknown) => {
      notifications.push(notification as RecordedNotification)
    },
    sendRequest: async () => {
      throw new Error('sendRequest is not supported in tests')
    },
    _meta: { progressToken: 'progress-1' },
  } as unknown as ToolExtra
}

/** Immediately-resolving sleep driving a virtual clock, so poll loops are
 * deterministic without real waiting. */
export function virtualClock(): {
  now: () => number
  sleep: (ms: number) => Promise<void>
} {
  let t = 0
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms
    },
  }
}

export async function writeDiscoveryFile(
  dataDir: string,
  backendPort: number,
  brokerPort: number,
  token = TEST_TOKEN,
  version = 1,
): Promise<void> {
  await writeFile(
    path.join(dataDir, 'integration.json'),
    JSON.stringify({
      version,
      app_version: '1.1.0',
      backend_port: backendPort,
      broker_port: brokerPort,
      token,
    }),
    { mode: 0o600 },
  )
}

/** Standard broker fake: info + permit + finalize + open-document. */
export function wireBroker(
  broker: FakeServer,
  options: {
    permit?: string
    permitError?: { status: number; error: string }
    finalizeId?: string
    finalizeError?: { status: number; error: string }
  } = {},
): void {
  const requireToken = (req: RecordedRequest, res: http.ServerResponse): boolean => {
    if (req.headers['x-stript-integration-token'] !== TEST_TOKEN) {
      json(res, 401, { error: 'invalid token' })
      return false
    }
    return true
  }
  broker.route('GET', '/v1/info', (req, res) => {
    if (!requireToken(req, res)) return
    json(res, 200, { protocol: 1, app_version: '1.1.0' })
  })
  broker.route('POST', '/v1/permit', (req, res) => {
    if (!requireToken(req, res)) return
    if (options.permitError !== undefined) {
      json(res, options.permitError.status, { error: options.permitError.error })
      return
    }
    json(res, 200, { permit: options.permit ?? 'permit-1' })
  })
  broker.route('POST', '/v1/finalize', (req, res) => {
    if (!requireToken(req, res)) return
    if (options.finalizeError !== undefined) {
      json(res, options.finalizeError.status, { error: options.finalizeError.error })
      return
    }
    json(res, 200, { native_reservation_id: options.finalizeId ?? 'native-res-1' })
  })
  broker.route('POST', '/v1/open-document', (req, res) => {
    if (!requireToken(req, res)) return
    res.writeHead(204)
    res.end()
  })
}
