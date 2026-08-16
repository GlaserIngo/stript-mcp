/** Best-effort probes for the Stript desktop app process.
 *
 * Every probe here is a hint, never an authority: a probe that cannot run
 * (missing tool, timeout, unexpected exit) resolves to null (unknown) so the
 * caller falls back to the plain discovery-file wait. No probe ever throws.
 */

import { execFile, spawn } from 'node:child_process'
import { access } from 'node:fs/promises'
import path from 'node:path'

const PROBE_TIMEOUT_MS = 2000

export interface ExecOutcome {
  /** Exit code, or null when the command could not run or timed out. */
  code: number | null
  stdout: string
}

export type ExecProbe = (cmd: string, args: string[]) => Promise<ExecOutcome>

export const defaultExecProbe: ExecProbe = (cmd, args) =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout: PROBE_TIMEOUT_MS, windowsHide: true }, (error, stdout) => {
      if (error === null) {
        resolve({ code: 0, stdout: stdout ?? '' })
        return
      }
      // Non-zero exits carry a numeric code. ENOENT/timeout/kill carry a
      // string code or none, both mean "could not determine".
      const code = typeof error.code === 'number' ? error.code : null
      resolve({ code, stdout: stdout ?? '' })
    })
  })

/** A definitive "no match" from pgrep: exit 1, or a clean run with no pids. */
function pgrepFoundNothing(outcome: ExecOutcome): boolean {
  return outcome.code === 1 || (outcome.code === 0 && outcome.stdout.trim().length === 0)
}

/** Whether the Stript desktop app process is running.
 *
 * Returns true / false when the platform probe answered definitively and
 * null when it could not tell (unsupported platform, probe failure). The
 * process name is the Tauri productName "Stript" (src-tauri/tauri.conf.json),
 * probed by exact name first and by bundle path as a fallback on macOS.
 */
export async function probeStriptProcess(
  platform: NodeJS.Platform,
  exec: ExecProbe = defaultExecProbe,
): Promise<boolean | null> {
  try {
    if (platform === 'darwin') {
      const byName = await exec('pgrep', ['-x', 'Stript'])
      if (byName.code === 0 && byName.stdout.trim().length > 0) return true
      const byPath = await exec('pgrep', ['-f', 'Stript.app/Contents/MacOS/Stript'])
      if (byPath.code === 0 && byPath.stdout.trim().length > 0) return true
      if (pgrepFoundNothing(byName) && pgrepFoundNothing(byPath)) return false
      return null
    }
    if (platform === 'win32') {
      const outcome = await exec('tasklist', ['/FI', 'IMAGENAME eq Stript.exe', '/NH'])
      if (outcome.code !== 0) return null
      // tasklist exits 0 either way and prints an INFO line on no match.
      return outcome.stdout.toLowerCase().includes('stript.exe')
    }
    return null
  } catch {
    return null
  }
}

// ── Windows launch ───────────────────────────────────────────────────────

export interface WindowsLocateDeps {
  env?: NodeJS.ProcessEnv
  fileExists?: (candidate: string) => Promise<boolean>
  exec?: ExecProbe
}

async function defaultFileExists(candidate: string): Promise<boolean> {
  try {
    await access(candidate)
    return true
  } catch {
    return false
  }
}

/** Tauri NSIS uninstall registry keys, productName first, then the bundle
 * identifier variant. */
const WINDOWS_UNINSTALL_KEYS = [
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Stript',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\io.stript.desktop',
]

/** Pull the value out of a `reg query /v InstallLocation` dump, defensively:
 * only the InstallLocation line, only a REG_SZ/REG_EXPAND_SZ value. */
function parseInstallLocation(stdout: string): string | null {
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.includes('InstallLocation')) continue
    const match = /REG_(?:EXPAND_)?SZ\s+(.+)$/.exec(line)
    const value = match?.[1]?.trim()
    if (value !== undefined && value.length > 0) return value
  }
  return null
}

/** Locate the installed Stript.exe on Windows.
 *
 * Tauri's NSIS bundle in currentUser mode installs under %LOCALAPPDATA%
 * ({productName} or Programs\{productName} depending on the NSIS version),
 * with the uninstall registry key as the fallback source of truth. Returns
 * null when nothing is found, never throws.
 */
export async function locateStriptExeWindows(deps: WindowsLocateDeps = {}): Promise<string | null> {
  const env = deps.env ?? process.env
  const fileExists = deps.fileExists ?? defaultFileExists
  const exec = deps.exec ?? defaultExecProbe
  try {
    const localAppData = env.LOCALAPPDATA
    if (typeof localAppData === 'string' && localAppData.length > 0) {
      const candidates = [
        path.win32.join(localAppData, 'Stript', 'Stript.exe'),
        path.win32.join(localAppData, 'Programs', 'Stript', 'Stript.exe'),
      ]
      for (const candidate of candidates) {
        if (await fileExists(candidate)) return candidate
      }
    }
    for (const key of WINDOWS_UNINSTALL_KEYS) {
      const outcome = await exec('reg', ['query', key, '/v', 'InstallLocation'])
      if (outcome.code !== 0) continue
      const installDir = parseInstallLocation(outcome.stdout)
      if (installDir === null) continue
      const candidate = path.win32.join(installDir, 'Stript.exe')
      if (await fileExists(candidate)) return candidate
    }
    return null
  } catch {
    return null
  }
}

/** Launch an executable fully detached so the bridge process never holds it.
 * Failures are swallowed, the discovery-file poll is the arbiter anyway. */
export function launchDetached(exePath: string): void {
  try {
    const child = spawn(exePath, [], { detached: true, stdio: 'ignore' })
    child.on('error', () => {
      // Swallowed: an exe that fails to start simply never writes the
      // discovery file and the caller returns guidance.
    })
    child.unref()
  } catch {
    // Same: fall through to the poll, which ends in guidance.
  }
}
