import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  connectToStript,
  NO_FILE_GUIDANCE,
  readDiscoveryFile,
  TOGGLE_OFF_GUIDANCE,
  UNREACHABLE_GUIDANCE,
} from '../src/discovery.js'
import { BridgeError } from '../src/errors.js'
import { makeStatusHandler } from '../src/tools/status.js'
import { createContext } from '../src/tools/shared.js'
import {
  fakeExtra,
  FakeServer,
  json,
  licensePayload,
  makeContext,
  makeSession,
  testConfig,
  tmpDir,
  virtualClock,
  wireBroker,
  writeDiscoveryFile,
} from './helpers.js'

describe('discovery', () => {
  let backend: FakeServer
  let broker: FakeServer

  beforeEach(async () => {
    backend = new FakeServer()
    broker = new FakeServer()
    await backend.start()
    await broker.start()
    wireBroker(broker)
    backend.route('GET', '/api/health', (_req, res) =>
      json(res, 200, {
        status: 'ok',
        version: '1.1.0',
        compute_profile: 'standard',
        models_loaded: { ner: true, slm: true },
      }),
    )
  })

  afterEach(async () => {
    await backend.stop()
    await broker.stop()
  })

  it('returns null when the discovery file is missing', async () => {
    const dataDir = await tmpDir('stript-data-')
    expect(await readDiscoveryFile(dataDir)).toBeNull()
  })

  it('raises actionable text on a protocol version mismatch', async () => {
    const dataDir = await tmpDir('stript-data-')
    await writeDiscoveryFile(dataDir, backend.port, broker.port, undefined, 2)
    const failure = await readDiscoveryFile(dataDir).catch((e: unknown) => e)
    expect(failure).toBeInstanceOf(BridgeError)
    expect((failure as BridgeError).message).toContain('version 2')
    expect((failure as BridgeError).message).toContain('Update Stript')
  })

  it('connects when the file is present and both surfaces are live', async () => {
    const dataDir = await tmpDir('stript-data-')
    await writeDiscoveryFile(dataDir, backend.port, broker.port)
    const endpoints = await connectToStript(testConfig({ dataDir }), { autoLaunch: false })
    expect(endpoints.backendBaseUrl).toBe(`http://127.0.0.1:${backend.port}/api`)
    expect(endpoints.brokerBaseUrl).toBe(`http://127.0.0.1:${broker.port}/v1`)
  })

  it('reports the no-file guidance when the app is not running', async () => {
    const dataDir = await tmpDir('stript-data-')
    await expect(
      connectToStript(testConfig({ dataDir }), { autoLaunch: false, platform: 'linux' }),
    ).rejects.toThrow(NO_FILE_GUIDANCE)
  })

  it('reports the stale guidance when the file exists but nothing answers', async () => {
    const dataDir = await tmpDir('stript-data-')
    await writeDiscoveryFile(dataDir, backend.port, broker.port)
    await backend.stop()
    await broker.stop()
    await expect(
      connectToStript(testConfig({ dataDir }), { autoLaunch: false }),
    ).rejects.toThrow(UNREACHABLE_GUIDANCE)
  })

  it('answers fast with the toggle guidance when the app runs without a file', async () => {
    const dataDir = await tmpDir('stript-data-')
    const clock = virtualClock()
    const launches: number[] = []
    const failure = await connectToStript(testConfig({ dataDir }), {
      platform: 'darwin',
      isAppRunning: async () => true,
      launch: async () => {
        launches.push(1)
      },
      sleep: clock.sleep,
      now: clock.now,
    }).catch((e: unknown) => e)
    expect(failure).toBeInstanceOf(BridgeError)
    expect((failure as BridgeError).message).toBe(TOGGLE_OFF_GUIDANCE)
    // No launch attempt and no long wait: one short re-read, then guidance.
    expect(launches).toHaveLength(0)
    expect(clock.now()).toBeLessThan(2000)
  })

  it('recovers when the file appears during the running-app re-read', async () => {
    const dataDir = await tmpDir('stript-data-')
    const endpoints = await connectToStript(testConfig({ dataDir }), {
      platform: 'darwin',
      isAppRunning: async () => true,
      sleep: async () => {
        await writeDiscoveryFile(dataDir, backend.port, broker.port)
      },
      launch: async () => {
        throw new Error('must not launch')
      },
    })
    expect(endpoints.backendBaseUrl).toBe(`http://127.0.0.1:${backend.port}/api`)
  })

  it('launches when the app is not running, then connects on the fresh file', async () => {
    const dataDir = await tmpDir('stript-data-')
    const clock = virtualClock()
    let launched = false
    const endpoints = await connectToStript(testConfig({ dataDir }), {
      platform: 'darwin',
      isAppRunning: async () => launched,
      launch: async () => {
        launched = true
        await writeDiscoveryFile(dataDir, backend.port, broker.port)
      },
      sleep: clock.sleep,
      now: clock.now,
    })
    expect(launched).toBe(true)
    expect(endpoints.brokerBaseUrl).toBe(`http://127.0.0.1:${broker.port}/v1`)
  })

  it('after a launch, a running app without a file resolves to the toggle guidance within the grace window', async () => {
    const dataDir = await tmpDir('stript-data-')
    const clock = virtualClock()
    let launched = false
    const failure = await connectToStript(testConfig({ dataDir }), {
      platform: 'darwin',
      isAppRunning: async () => (launched ? true : false),
      launch: async () => {
        launched = true
      },
      sleep: clock.sleep,
      now: clock.now,
    }).catch((e: unknown) => e)
    expect(failure).toBeInstanceOf(BridgeError)
    expect((failure as BridgeError).message).toBe(TOGGLE_OFF_GUIDANCE)
    // Grace window (~10s), far below the full 30s launch wait.
    expect(clock.now()).toBeLessThan(15_000)
  })

  it('an unknown probe keeps the plain wait and ends in the no-file guidance', async () => {
    const dataDir = await tmpDir('stript-data-')
    const clock = virtualClock()
    const failure = await connectToStript(testConfig({ dataDir }), {
      platform: 'darwin',
      isAppRunning: async () => null,
      launch: async () => {
        // Launched, but the file never appears and the probe cannot tell.
      },
      sleep: clock.sleep,
      now: clock.now,
    }).catch((e: unknown) => e)
    expect(failure).toBeInstanceOf(BridgeError)
    expect((failure as BridgeError).message).toBe(NO_FILE_GUIDANCE)
    expect(clock.now()).toBeGreaterThanOrEqual(30_000)
  })

  it('Windows: launches when the app is not running, then connects on the fresh file', async () => {
    const dataDir = await tmpDir('stript-data-')
    const clock = virtualClock()
    let launched = false
    const endpoints = await connectToStript(testConfig({ dataDir }), {
      platform: 'win32',
      isAppRunning: async () => launched,
      launch: async () => {
        launched = true
        await writeDiscoveryFile(dataDir, backend.port, broker.port)
      },
      sleep: clock.sleep,
      now: clock.now,
    })
    expect(launched).toBe(true)
    expect(endpoints.backendBaseUrl).toBe(`http://127.0.0.1:${backend.port}/api`)
  })

  it('Windows: an unlocatable install skips the launch and returns guidance fast', async () => {
    const dataDir = await tmpDir('stript-data-')
    const clock = virtualClock()
    // No injected launch: the real Windows locator runs, finds nothing on
    // this machine (no LOCALAPPDATA install, no reg tool), and the connect
    // falls straight through to guidance without any polling wait.
    const failure = await connectToStript(testConfig({ dataDir }), {
      platform: 'win32',
      isAppRunning: async () => false,
      sleep: clock.sleep,
      now: clock.now,
    }).catch((e: unknown) => e)
    expect(failure).toBeInstanceOf(BridgeError)
    expect((failure as BridgeError).message).toBe(NO_FILE_GUIDANCE)
    expect(clock.now()).toBe(0)
  })

  it('Linux stays guidance-only, no launch attempt', async () => {
    const dataDir = await tmpDir('stript-data-')
    const failure = await connectToStript(testConfig({ dataDir }), {
      platform: 'linux',
      isAppRunning: async () => false,
    }).catch((e: unknown) => e)
    expect(failure).toBeInstanceOf(BridgeError)
    expect((failure as BridgeError).message).toBe(NO_FILE_GUIDANCE)
  })

  it('a throwing probe never escapes, the plain wait behavior stays', async () => {
    const dataDir = await tmpDir('stript-data-')
    const clock = virtualClock()
    const failure = await connectToStript(testConfig({ dataDir }), {
      platform: 'darwin',
      isAppRunning: async () => {
        throw new Error('probe exploded')
      },
      launch: async () => {
        // No file ever appears.
      },
      sleep: clock.sleep,
      now: clock.now,
    }).catch((e: unknown) => e)
    expect(failure).toBeInstanceOf(BridgeError)
    expect((failure as BridgeError).message).toBe(NO_FILE_GUIDANCE)
  })

  it('createContext connects through the discovery file', async () => {
    const dataDir = await tmpDir('stript-data-')
    await writeDiscoveryFile(dataDir, backend.port, broker.port)
    const ctx = createContext(testConfig({ dataDir }), { autoLaunch: false })
    const session = await ctx.connect()
    expect(session.discovery.backend_port).toBe(backend.port)
  })
})

describe('stript_status', () => {
  let backend: FakeServer
  let broker: FakeServer

  beforeEach(async () => {
    backend = new FakeServer()
    broker = new FakeServer()
    await backend.start()
    await broker.start()
    wireBroker(broker)
    backend.route('GET', '/api/health', (_req, res) =>
      json(res, 200, {
        status: 'ok',
        version: '1.1.0',
        compute_profile: 'standard',
        models_loaded: { ner: true, slm: true },
      }),
    )
    backend.route('GET', '/api/license/status', (_req, res) => json(res, 200, licensePayload(4)))
  })

  afterEach(async () => {
    await backend.stop()
    await broker.stop()
  })

  it('reports app_running false with guidance when there is no discovery file', async () => {
    const dataDir = await tmpDir('stript-data-')
    const ctx = makeContext(makeSession(backend, broker), testConfig({ dataDir }))
    const result = await makeStatusHandler(ctx)({}, fakeExtra())
    const structured = result.structuredContent as Record<string, unknown>
    expect(structured.app_running).toBe(false)
    expect(structured.guidance).toBe(NO_FILE_GUIDANCE)
  })

  it('reports the full status when the app is live', async () => {
    const dataDir = await tmpDir('stript-data-')
    await writeDiscoveryFile(dataDir, backend.port, broker.port)
    const ctx = makeContext(makeSession(backend, broker), testConfig({ dataDir }))
    const result = await makeStatusHandler(ctx)({}, fakeExtra())
    const structured = result.structuredContent as Record<string, unknown>
    expect(structured).toMatchObject({
      app_running: true,
      app_version: '1.1.0',
      backend_version: '1.1.0',
      integration_enabled: true,
      tier: 'free',
      evaluation_remaining: 4,
      models_ready: true,
    })
  })

  it('reports the version mismatch guidance for a newer protocol', async () => {
    const dataDir = await tmpDir('stript-data-')
    await writeDiscoveryFile(dataDir, backend.port, broker.port, undefined, 3)
    const ctx = makeContext(makeSession(backend, broker), testConfig({ dataDir }))
    const result = await makeStatusHandler(ctx)({}, fakeExtra())
    const structured = result.structuredContent as Record<string, unknown>
    expect(structured.app_running).toBe(false)
    expect(String(structured.guidance)).toContain('version 3')
  })
})
