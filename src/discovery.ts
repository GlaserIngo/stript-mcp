import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { launchDetached, locateStriptExeWindows, probeStriptProcess } from './appProcess.js'
import type { BridgeConfig } from './config.js'
import { BridgeError } from './errors.js'
import type { BrokerInfoResponse } from './types.js'

/** The one discovery protocol version this bridge supports. */
export const SUPPORTED_DISCOVERY_VERSION = 1

/** Shape of {STRIPT_DATA_DIR or ~/.stript}/integration.json (contract section 2). */
export interface DiscoveryInfo {
  version: number
  app_version: string
  backend_port: number
  broker_port: number
  token: string
}

/** A live, probed connection target. */
export interface StriptEndpoints {
  discovery: DiscoveryInfo
  /** http://127.0.0.1:{backend_port}/api */
  backendBaseUrl: string
  /** http://127.0.0.1:{broker_port}/v1 */
  brokerBaseUrl: string
  token: string
}

export const TOGGLE_OFF_GUIDANCE =
  'Stript is running but AI integrations are turned off. In Stript, open ' +
  'Settings, go to Data & Privacy, and turn on AI integrations, then try ' +
  'again. No restart is needed.'

export const NO_FILE_GUIDANCE =
  'Stript is not running with AI integrations enabled. Open Stript, turn on ' +
  'AI integrations in Settings, then try again. This needs the Stript release ' +
  'that ships AI integrations.'

export const UNREACHABLE_GUIDANCE =
  'A Stript integration file exists but the app is not reachable. Stript may ' +
  'have quit or restarted. Open Stript, confirm AI integrations is turned on ' +
  'in Settings, then try again.'

export function versionMismatchGuidance(found: number): string {
  return (
    `This Stript app uses integration protocol version ${found} but this ` +
    `bridge supports version ${SUPPORTED_DISCOVERY_VERSION}. Update Stript ` +
    'and the Stript MCP bridge so they match.'
  )
}

/** Validate the discovery protocol version, else raise actionable text. */
export function assertSupportedVersion(version: number): void {
  if (version !== SUPPORTED_DISCOVERY_VERSION) {
    throw new BridgeError(versionMismatchGuidance(version))
  }
}

export function discoveryFilePath(dataDir: string): string {
  return path.join(dataDir, 'integration.json')
}

/** Read and validate the discovery file.
 *
 * Returns null when the file is missing or unparseable (treated as "app not
 * running with integrations enabled"). Throws a version-mismatch BridgeError
 * when the file is well-formed but speaks another protocol version.
 */
export async function readDiscoveryFile(dataDir: string): Promise<DiscoveryInfo | null> {
  let raw: string
  try {
    raw = await readFile(discoveryFilePath(dataDir), 'utf8')
  } catch {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const record = parsed as Record<string, unknown>
  if (typeof record.version !== 'number') return null
  assertSupportedVersion(record.version)
  if (
    typeof record.backend_port !== 'number' ||
    typeof record.broker_port !== 'number' ||
    typeof record.token !== 'string' ||
    record.token.length === 0
  ) {
    return null
  }
  return {
    version: record.version,
    app_version: typeof record.app_version === 'string' ? record.app_version : '',
    backend_port: record.backend_port,
    broker_port: record.broker_port,
    token: record.token,
  }
}

const PROBE_TIMEOUT_MS = 3000

async function probeBackend(baseUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl}/health`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
    return response.ok
  } catch {
    return false
  }
}

async function probeBroker(baseUrl: string, token: string): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl}/info`, {
      headers: { 'X-Stript-Integration-Token': token },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
    if (!response.ok) return false
    const body = (await response.json()) as BrokerInfoResponse
    if (typeof body.protocol === 'number' && body.protocol !== SUPPORTED_DISCOVERY_VERSION) {
      throw new BridgeError(versionMismatchGuidance(body.protocol))
    }
    return true
  } catch (error) {
    if (error instanceof BridgeError) throw error
    return false
  }
}

function endpointsFor(discovery: DiscoveryInfo): StriptEndpoints {
  return {
    discovery,
    backendBaseUrl: `http://127.0.0.1:${discovery.backend_port}/api`,
    brokerBaseUrl: `http://127.0.0.1:${discovery.broker_port}/v1`,
    token: discovery.token,
  }
}

async function readAndProbe(dataDir: string): Promise<StriptEndpoints | 'missing' | 'unreachable'> {
  const discovery = await readDiscoveryFile(dataDir)
  if (discovery === null) return 'missing'
  const endpoints = endpointsFor(discovery)
  const [backendOk, brokerOk] = await Promise.all([
    probeBackend(endpoints.backendBaseUrl),
    probeBroker(endpoints.brokerBaseUrl, endpoints.token),
  ])
  if (!backendOk || !brokerOk) return 'unreachable'
  return endpoints
}

export interface ConnectOptions {
  /** Attempt an auto-launch when the app is not running. Default true. */
  autoLaunch?: boolean
  /** Total time to wait for a fresh discovery file after launching. */
  launchWaitMs?: number
  /** How long a RUNNING app gets to write the discovery file after launch
   * before the missing file is read as "integrations toggle is off". */
  runningGraceMs?: number
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>
  /** Injectable for tests. */
  now?: () => number
  /** Injectable for tests. */
  platform?: NodeJS.Platform
  /** Injectable for tests. */
  launch?: () => Promise<void>
  /** Injectable process probe. true/false when definitive, null when the
   * probe could not tell (falls back to the plain discovery-file wait). */
  isAppRunning?: () => Promise<boolean | null>
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function launchStriptMacos(): Promise<void> {
  return new Promise((resolve) => {
    execFile('open', ['-b', 'io.stript.desktop'], () => resolve())
  })
}

/** Pick the platform launcher, or null when this platform has none (Linux
 * stays guidance-only, Windows without a locatable install too). */
async function resolveDefaultLaunch(
  platform: NodeJS.Platform,
): Promise<(() => Promise<void>) | null> {
  if (platform === 'darwin') return launchStriptMacos
  if (platform === 'win32') {
    const exePath = await locateStriptExeWindows()
    if (exePath === null) return null
    return async () => {
      launchDetached(exePath)
    }
  }
  return null
}

async function safeIsRunning(probe: () => Promise<boolean | null>): Promise<boolean | null> {
  try {
    return await probe()
  } catch {
    return null
  }
}

/** Locate the running Stript app: read the discovery file (re-read on every
 * tool call since ports and token rotate per launch), then probe liveness on
 * both surfaces.
 *
 * A missing file has two very different causes and the bridge tells them
 * apart with a process probe:
 * - the app process is already RUNNING: the AI integrations toggle is off,
 *   return the toggle guidance within seconds instead of waiting,
 * - the app is NOT running: auto-launch it (macOS/Windows) and poll for the
 *   fresh file. The host writes the file early in launch while the toggle is
 *   on, so once the process appears, a short grace window without a file also
 *   resolves to the toggle guidance instead of running out the full wait.
 * A probe that cannot tell keeps the plain wait-for-file behavior. */
export async function connectToStript(
  config: BridgeConfig,
  options: ConnectOptions = {},
): Promise<StriptEndpoints> {
  const platform = options.platform ?? process.platform
  const sleep = options.sleep ?? defaultSleep
  const now = options.now ?? Date.now
  const launchWaitMs = options.launchWaitMs ?? 30_000
  const runningGraceMs = options.runningGraceMs ?? 10_000
  const autoLaunch = options.autoLaunch ?? true
  const isAppRunning = options.isAppRunning ?? (() => probeStriptProcess(platform))

  const first = await readAndProbe(config.dataDir)
  if (first !== 'missing' && first !== 'unreachable') return first
  if (first === 'unreachable') throw new BridgeError(UNREACHABLE_GUIDANCE)
  if (!autoLaunch) throw new BridgeError(NO_FILE_GUIDANCE)

  // The app is already running without a discovery file: the toggle is off.
  // One short re-read absorbs the race where the file is being written at
  // this very moment, then answer fast with actionable guidance.
  if ((await safeIsRunning(isAppRunning)) === true) {
    await sleep(750)
    const retry = await readAndProbe(config.dataDir)
    if (retry !== 'missing' && retry !== 'unreachable') return retry
    throw new BridgeError(TOGGLE_OFF_GUIDANCE)
  }

  const launch =
    options.launch !== undefined ? options.launch : await resolveDefaultLaunch(platform)
  if (launch === null) throw new BridgeError(NO_FILE_GUIDANCE)

  await launch()
  const deadline = now() + launchWaitMs
  let runningSince: number | null = null
  while (now() < deadline) {
    await sleep(1500)
    const retry = await readAndProbe(config.dataDir)
    if (retry !== 'missing' && retry !== 'unreachable') return retry
    const running = await safeIsRunning(isAppRunning)
    if (running === true) {
      runningSince ??= now()
      if (now() - runningSince >= runningGraceMs) {
        throw new BridgeError(TOGGLE_OFF_GUIDANCE)
      }
    } else if (running === false) {
      runningSince = null
    }
    // running === null: probe could not tell, keep the plain file wait.
  }
  throw new BridgeError(NO_FILE_GUIDANCE)
}
