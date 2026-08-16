import { describe, expect, it } from 'vitest'

import {
  locateStriptExeWindows,
  probeStriptProcess,
  type ExecOutcome,
  type ExecProbe,
} from '../src/appProcess.js'

function fakeExec(script: Record<string, ExecOutcome>): ExecProbe {
  return async (cmd, args) => {
    const key = `${cmd} ${args.join(' ')}`
    const outcome = script[key]
    if (outcome === undefined) throw new Error(`unexpected exec: ${key}`)
    return outcome
  }
}

describe('probeStriptProcess', () => {
  it('macOS: reports running on a pgrep name match', async () => {
    const exec = fakeExec({
      'pgrep -x Stript': { code: 0, stdout: '4242\n' },
    })
    expect(await probeStriptProcess('darwin', exec)).toBe(true)
  })

  it('macOS: falls back to the bundle-path match', async () => {
    const exec = fakeExec({
      'pgrep -x Stript': { code: 1, stdout: '' },
      'pgrep -f Stript.app/Contents/MacOS/Stript': { code: 0, stdout: '4242\n' },
    })
    expect(await probeStriptProcess('darwin', exec)).toBe(true)
  })

  it('macOS: both probes empty means definitively not running', async () => {
    const exec = fakeExec({
      'pgrep -x Stript': { code: 1, stdout: '' },
      'pgrep -f Stript.app/Contents/MacOS/Stript': { code: 1, stdout: '' },
    })
    expect(await probeStriptProcess('darwin', exec)).toBe(false)
  })

  it('macOS: a probe that could not run reports unknown', async () => {
    const exec = fakeExec({
      'pgrep -x Stript': { code: 1, stdout: '' },
      'pgrep -f Stript.app/Contents/MacOS/Stript': { code: null, stdout: '' },
    })
    expect(await probeStriptProcess('darwin', exec)).toBeNull()
  })

  it('macOS: a throwing probe reports unknown, never throws', async () => {
    const exec: ExecProbe = async () => {
      throw new Error('probe exploded')
    }
    expect(await probeStriptProcess('darwin', exec)).toBeNull()
  })

  it('Windows: tasklist match means running', async () => {
    const exec = fakeExec({
      'tasklist /FI IMAGENAME eq Stript.exe /NH': {
        code: 0,
        stdout: 'Stript.exe                    5124 Console    1     181.204 K\r\n',
      },
    })
    expect(await probeStriptProcess('win32', exec)).toBe(true)
  })

  it('Windows: the INFO no-tasks line means not running', async () => {
    const exec = fakeExec({
      'tasklist /FI IMAGENAME eq Stript.exe /NH': {
        code: 0,
        stdout: 'INFO: No tasks are running which match the specified criteria.\r\n',
      },
    })
    expect(await probeStriptProcess('win32', exec)).toBe(false)
  })

  it('Windows: a failed tasklist reports unknown', async () => {
    const exec = fakeExec({
      'tasklist /FI IMAGENAME eq Stript.exe /NH': { code: null, stdout: '' },
    })
    expect(await probeStriptProcess('win32', exec)).toBeNull()
  })

  it('Linux reports unknown without running anything', async () => {
    const exec: ExecProbe = async () => {
      throw new Error('must not be called')
    }
    expect(await probeStriptProcess('linux', exec)).toBeNull()
  })
})

describe('locateStriptExeWindows', () => {
  const LOCAL = 'C:\\Users\\ingo\\AppData\\Local'
  const noExec: ExecProbe = async () => {
    throw new Error('reg must not be queried')
  }

  it('finds the exe in %LOCALAPPDATA%\\Stript first', async () => {
    const found = await locateStriptExeWindows({
      env: { LOCALAPPDATA: LOCAL },
      fileExists: async (p) => p === `${LOCAL}\\Stript\\Stript.exe`,
      exec: noExec,
    })
    expect(found).toBe(`${LOCAL}\\Stript\\Stript.exe`)
  })

  it('falls back to %LOCALAPPDATA%\\Programs\\Stript', async () => {
    const found = await locateStriptExeWindows({
      env: { LOCALAPPDATA: LOCAL },
      fileExists: async (p) => p === `${LOCAL}\\Programs\\Stript\\Stript.exe`,
      exec: noExec,
    })
    expect(found).toBe(`${LOCAL}\\Programs\\Stript\\Stript.exe`)
  })

  it('falls back to the uninstall registry InstallLocation', async () => {
    const installDir = 'D:\\Apps\\Stript'
    const queried: string[] = []
    const found = await locateStriptExeWindows({
      env: { LOCALAPPDATA: LOCAL },
      fileExists: async (p) => p === `${installDir}\\Stript.exe`,
      exec: async (cmd, args) => {
        expect(cmd).toBe('reg')
        queried.push(args[1] ?? '')
        return {
          code: 0,
          stdout:
            '\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Stript\r\n' +
            `    InstallLocation    REG_SZ    ${installDir}\r\n\r\n`,
        }
      },
    })
    expect(found).toBe(`${installDir}\\Stript.exe`)
    expect(queried[0]).toContain('Uninstall\\Stript')
  })

  it('tries the bundle-identifier registry key variant', async () => {
    const installDir = 'D:\\Apps\\Stript'
    const found = await locateStriptExeWindows({
      env: {},
      fileExists: async (p) => p === `${installDir}\\Stript.exe`,
      exec: async (_cmd, args) => {
        if ((args[1] ?? '').endsWith('io.stript.desktop')) {
          return {
            code: 0,
            stdout: `    InstallLocation    REG_EXPAND_SZ    ${installDir}\r\n`,
          }
        }
        return { code: 1, stdout: '' }
      },
    })
    expect(found).toBe(`${installDir}\\Stript.exe`)
  })

  it('returns null when nothing is installed, with a garbage registry dump', async () => {
    const found = await locateStriptExeWindows({
      env: { LOCALAPPDATA: LOCAL },
      fileExists: async () => false,
      exec: async () => ({ code: 0, stdout: 'InstallLocation without a value type\r\n' }),
    })
    expect(found).toBeNull()
  })

  it('never throws when a dependency explodes', async () => {
    const found = await locateStriptExeWindows({
      env: { LOCALAPPDATA: LOCAL },
      fileExists: async () => {
        throw new Error('fs exploded')
      },
      exec: noExec,
    })
    expect(found).toBeNull()
  })
})
