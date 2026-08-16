import { mkdir, readFile, symlink, truncate, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { beforeEach, describe, expect, it } from 'vitest'

import { FileGuardError, guardInputFile, sanitizeFilename, writeOutputFile } from '../src/files.js'
import { tmpDir } from './helpers.js'

describe('input file guards (contract section 7)', () => {
  let allowed: string
  let outside: string

  beforeEach(async () => {
    allowed = await tmpDir('stript-allowed-')
    outside = await tmpDir('stript-outside-')
  })

  it('accepts a regular supported file inside an allowed directory', async () => {
    const file = path.join(allowed, 'brief.txt')
    await writeFile(file, 'hello')
    const guarded = await guardInputFile(file, [allowed])
    expect(guarded.filename).toBe('brief.txt')
    expect(guarded.size).toBe(5)
  })

  it('refuses a missing file', async () => {
    await expect(guardInputFile(path.join(allowed, 'nope.txt'), [allowed])).rejects.toThrow(
      FileGuardError,
    )
  })

  it('refuses a directory path', async () => {
    const dir = path.join(allowed, 'folder.txt')
    await mkdir(dir)
    await expect(guardInputFile(dir, [allowed])).rejects.toThrow('regular file')
  })

  it('refuses a file outside every allowed directory', async () => {
    const file = path.join(outside, 'secret.txt')
    await writeFile(file, 'secret')
    await expect(guardInputFile(file, [allowed])).rejects.toThrow('outside the allowed folders')
  })

  it('refuses a symlink that escapes the allowed directory', async () => {
    const target = path.join(outside, 'secret.txt')
    await writeFile(target, 'secret')
    const link = path.join(allowed, 'looks-safe.txt')
    await symlink(target, link)
    await expect(guardInputFile(link, [allowed])).rejects.toThrow('outside the allowed folders')
  })

  it('refuses dotfiles and files under hidden directories', async () => {
    const hiddenDir = path.join(allowed, '.private')
    await mkdir(hiddenDir)
    const inHidden = path.join(hiddenDir, 'doc.txt')
    await writeFile(inHidden, 'x')
    await expect(guardInputFile(inHidden, [allowed])).rejects.toThrow('dot')

    const dotfile = path.join(allowed, '.env.txt')
    await writeFile(dotfile, 'x')
    await expect(guardInputFile(dotfile, [allowed])).rejects.toThrow('dot')
  })

  it('refuses unsupported extensions', async () => {
    const file = path.join(allowed, 'tool.exe')
    await writeFile(file, 'x')
    await expect(guardInputFile(file, [allowed])).rejects.toThrow('Unsupported file type')
  })

  it('refuses files over 50 MB', async () => {
    const file = path.join(allowed, 'big.pdf')
    await writeFile(file, 'x')
    await truncate(file, 50 * 1024 * 1024 + 1)
    await expect(guardInputFile(file, [allowed])).rejects.toThrow('50 MB')
  })

  it('skips allowed directories that do not exist', async () => {
    const file = path.join(allowed, 'brief.docx')
    await writeFile(file, 'x')
    const guarded = await guardInputFile(file, [path.join(outside, 'missing-dir'), allowed])
    expect(guarded.filename).toBe('brief.docx')
  })
})

describe('output writer', () => {
  it('never overwrites, suffixing -1, -2 on collisions', async () => {
    const out = await tmpDir('stript-out-')
    const first = await writeOutputFile(out, 'result.txt', 'one')
    const second = await writeOutputFile(out, 'result.txt', 'two')
    const third = await writeOutputFile(out, 'result.txt', 'three')
    expect(path.basename(first)).toBe('result.txt')
    expect(path.basename(second)).toBe('result-1.txt')
    expect(path.basename(third)).toBe('result-2.txt')
    expect(await readFile(first, 'utf8')).toBe('one')
    expect(await readFile(second, 'utf8')).toBe('two')
    expect(await readFile(third, 'utf8')).toBe('three')
  })

  it('creates the output directory when missing', async () => {
    const out = path.join(await tmpDir('stript-out-'), 'nested', 'deeper')
    const written = await writeOutputFile(out, 'a.txt', 'data')
    expect(await readFile(written, 'utf8')).toBe('data')
  })

  it('sanitizes hostile output names', () => {
    expect(sanitizeFilename('../../evil.txt')).toBe('evil.txt')
    expect(sanitizeFilename('.hidden')).toBe('hidden')
    expect(sanitizeFilename('  ')).toBe('restored.txt')
    expect(sanitizeFilename('a:b*c.txt')).toBe('a_b_c.txt')
  })
})
