import { describe, expect, it } from 'vitest'

import { utf8Env } from '../src/clipboard.js'

describe('utf8Env', () => {
  it('forces a UTF-8 text locale when the environment declares none', () => {
    const env = utf8Env({ PATH: '/usr/bin' })
    expect(env.LC_CTYPE).toBe('UTF-8')
    expect(env.PATH).toBe('/usr/bin')
  })

  it('forces UTF-8 when the declared locale is not UTF-8', () => {
    const env = utf8Env({ LC_ALL: 'C' })
    expect(env.LC_CTYPE).toBe('UTF-8')
  })

  it('keeps an environment that already declares UTF-8 via LANG', () => {
    const base = { LANG: 'de_DE.UTF-8' }
    expect(utf8Env(base)).toBe(base)
  })

  it('accepts the dashless lowercase utf8 spelling', () => {
    const base = { LANG: 'en_US.utf8' }
    expect(utf8Env(base)).toBe(base)
  })

  it('accepts UTF-8 declared via LC_CTYPE alone', () => {
    const base = { LC_CTYPE: 'UTF-8' }
    expect(utf8Env(base)).toBe(base)
  })
})
