import { execFile } from 'node:child_process'

import { BridgeError } from './errors.js'

/** pbcopy and pbpaste interpret their byte stream using the process locale.
 * Claude Desktop spawns the bridge from launchd with NO locale variables, so
 * macOS falls back to MacRoman and every non-ASCII character round-trips
 * mangled (field-observed: umlauts became two-character garbage). Force a
 * UTF-8 text locale unless the environment already declares one. */
export function utf8Env(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const declared = [base.LC_ALL, base.LC_CTYPE, base.LANG]
  if (declared.some((value) => value !== undefined && /utf-?8/i.test(value))) return base
  return { ...base, LC_CTYPE: 'UTF-8' }
}

/** Run an OS command, optionally piping input via stdin (never argv, so
 * multi-byte UTF-8 and arbitrarily long text are safe), and capture stdout. */
function run(command: string, args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      command,
      args,
      { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, env: utf8Env() },
      (error, stdout) => {
        if (error) {
          reject(new Error(`${command} failed: ${error.message}`))
          return
        }
        resolve(stdout.toString('utf8'))
      },
    )
    if (child.stdin) {
      child.stdin.on('error', () => {
        // EPIPE when the command exits early, the close callback reports it.
      })
      if (input !== undefined) child.stdin.write(input, 'utf8')
      child.stdin.end()
    }
  })
}

async function firstWorking(candidates: Array<() => Promise<string>>): Promise<string> {
  let lastError: unknown = null
  for (const candidate of candidates) {
    try {
      return await candidate()
    } catch (error) {
      lastError = error
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new BridgeError('No clipboard command is available on this system.')
}

const PS_READ =
  '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; Get-Clipboard -Raw'
const PS_WRITE =
  '[Console]::InputEncoding=[System.Text.Encoding]::UTF8; ' +
  '$stript_clip=[Console]::In.ReadToEnd(); Set-Clipboard -Value $stript_clip'

/** Read the OS clipboard as text. */
export async function readClipboard(platform: NodeJS.Platform = process.platform): Promise<string> {
  switch (platform) {
    case 'darwin':
      return run('pbpaste', [])
    case 'win32':
      return run('powershell', ['-NoProfile', '-Command', PS_READ])
    default: {
      const wayland = process.env.WAYLAND_DISPLAY !== undefined
      const viaWl = (): Promise<string> => run('wl-paste', ['--no-newline'])
      const viaXclip = (): Promise<string> => run('xclip', ['-selection', 'clipboard', '-o'])
      return firstWorking(wayland ? [viaWl, viaXclip] : [viaXclip, viaWl])
    }
  }
}

/** Write text to the OS clipboard via stdin piping. */
export async function writeClipboard(
  text: string,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  switch (platform) {
    case 'darwin':
      await run('pbcopy', [], text)
      return
    case 'win32':
      await run('powershell', ['-NoProfile', '-Command', PS_WRITE], text)
      return
    default: {
      const wayland = process.env.WAYLAND_DISPLAY !== undefined
      const viaWl = (): Promise<string> => run('wl-copy', [], text)
      const viaXclip = (): Promise<string> => run('xclip', ['-selection', 'clipboard', '-in'], text)
      await firstWorking(wayland ? [viaWl, viaXclip] : [viaXclip, viaWl])
    }
  }
}
