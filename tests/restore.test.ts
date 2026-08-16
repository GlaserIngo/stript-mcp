import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { makeRestoreHandler } from '../src/tools/restore.js'
import { makeRestoreFileHandler } from '../src/tools/restoreFile.js'
import {
  docPayload,
  fakeExtra,
  FakeServer,
  json,
  makeContext,
  makeSession,
  testConfig,
  tmpDir,
  wireBroker,
} from './helpers.js'

vi.mock('../src/clipboard.js', () => ({
  readClipboard: vi.fn(async () => ''),
  writeClipboard: vi.fn(async () => undefined),
}))

const RESTORED_SENTINEL = 'SECRET Hans Krassnig, Ottakringer Str. 9'

describe('stript_restore', () => {
  let backend: FakeServer
  let broker: FakeServer
  let out: string

  beforeEach(async () => {
    backend = new FakeServer()
    broker = new FakeServer()
    await backend.start()
    await broker.start()
    wireBroker(broker)
    out = await tmpDir('stript-restore-out-')
    backend.route('POST', '/api/anonymization/deanonymize', (req, res) => {
      const body = JSON.parse(req.body) as Record<string, unknown>
      expect(body.allow_bracketless).toBe(false)
      json(res, 200, {
        restored_text: RESTORED_SENTINEL,
        replacements_made: 2,
        unmatched_placeholders: ['[PERSON_9]'],
        ambiguous_skipped: [],
        exact_restore: true,
      })
    })
  })

  afterEach(async () => {
    await backend.stop()
    await broker.stop()
    vi.clearAllMocks()
  })

  it('writes to a file and structurally cannot return the restored text', async () => {
    const ctx = makeContext(makeSession(backend, broker), testConfig({ outputDir: out }))
    const handler = makeRestoreHandler(ctx)
    const result = await handler(
      { text: 'Dear [PERSON_1] from [ADDRESS_1]', destination: 'file', filename: 'letter.txt' },
      fakeExtra(),
    )

    expect(result.isError).toBeUndefined()
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain('SECRET')
    expect(serialized).not.toContain('Krassnig')

    const structured = result.structuredContent as Record<string, unknown>
    expect(structured.replacements_made).toBe(2)
    expect(structured.unmatched_placeholders).toEqual(['[PERSON_9]'])
    expect(structured.exact_restore).toBe(true)
    expect(structured.destination).toBe('file')

    const written = structured.path as string
    expect(path.dirname(written)).toBe(out)
    expect(await readFile(written, 'utf8')).toBe(RESTORED_SENTINEL)
  })

  it('writes to the clipboard by default and returns counts only', async () => {
    const clipboard = await import('../src/clipboard.js')
    const ctx = makeContext(makeSession(backend, broker), testConfig({ outputDir: out }))
    const handler = makeRestoreHandler(ctx)
    const result = await handler(
      { text: 'Dear [PERSON_1]', destination: 'clipboard' },
      fakeExtra(),
    )
    expect(result.isError).toBeUndefined()
    expect(vi.mocked(clipboard.writeClipboard)).toHaveBeenCalledWith(RESTORED_SENTINEL)
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain('SECRET')
    const structured = result.structuredContent as Record<string, unknown>
    expect(structured.destination).toBe('clipboard')
    expect(structured.path).toBeUndefined()
  })

  it('sends the configured default project', async () => {
    const ctx = makeContext(
      makeSession(backend, broker),
      testConfig({ outputDir: out, defaultProject: 'kanzlei' }),
    )
    await makeRestoreHandler(ctx)({ text: '[PERSON_1]', destination: 'file' }, fakeExtra())
    const calls = backend.requestsFor('POST', '/api/anonymization/deanonymize')
    expect(JSON.parse(calls[0]?.body ?? '{}').project_id).toBe('kanzlei')
  })
})

describe('stript_restore_file', () => {
  let backend: FakeServer
  let broker: FakeServer
  let allowed: string
  let out: string

  beforeEach(async () => {
    backend = new FakeServer()
    broker = new FakeServer()
    await backend.start()
    await broker.start()
    wireBroker(broker)
    allowed = await tmpDir('stript-restore-allowed-')
    out = await tmpDir('stript-restore-out-')
    backend.route('GET', '/api/documents/doc1', (_req, res) => json(res, 200, docPayload()))
  })

  afterEach(async () => {
    await backend.stop()
    await broker.stop()
  })

  it('writes the format-preserving download and never returns content', async () => {
    const docxBytes = Buffer.from('PK-fake-docx-with-SECRET-original')
    backend.route('POST', '/api/anonymization/deanonymize-file', (_req, res) => {
      json(res, 200, {
        input_text: 'input with [PERSON_1]',
        restored_text: RESTORED_SENTINEL,
        replacements_made: 3,
        unmatched_placeholders: [],
        ambiguous_skipped: [],
        warnings: [],
        download: {
          filename: 'answer-restored.docx',
          format: 'docx',
          mime_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          file_base64: docxBytes.toString('base64'),
        },
        exact_restore: false,
      })
    })
    const { writeFile } = await import('node:fs/promises')
    const input = path.join(allowed, 'answer.docx')
    await writeFile(input, 'placeholder content [PERSON_1]')

    const ctx = makeContext(
      makeSession(backend, broker),
      testConfig({ outputDir: out, allowedDirs: [allowed] }),
    )
    const result = await makeRestoreFileHandler(ctx)({ path: input }, fakeExtra())

    expect(result.isError).toBeUndefined()
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain('SECRET')
    expect(serialized).not.toContain('input with')

    const structured = result.structuredContent as Record<string, unknown>
    expect(structured.replacements_made).toBe(3)
    expect(structured.format).toBe('docx')
    const written = structured.path as string
    expect(path.dirname(written)).toBe(out)
    expect(await readFile(written)).toEqual(docxBytes)
  })

  it('falls back to a restored .txt when no download is offered', async () => {
    backend.route('POST', '/api/anonymization/deanonymize-file', (_req, res) => {
      json(res, 200, {
        input_text: 'input',
        restored_text: RESTORED_SENTINEL,
        replacements_made: 1,
        unmatched_placeholders: [],
        ambiguous_skipped: [],
        warnings: [{ code: 'X', message: 'Format could not be preserved' }],
        download: null,
        exact_restore: false,
      })
    })
    const { writeFile } = await import('node:fs/promises')
    const input = path.join(allowed, 'answer.txt')
    await writeFile(input, '[PERSON_1]')

    const ctx = makeContext(
      makeSession(backend, broker),
      testConfig({ outputDir: out, allowedDirs: [allowed] }),
    )
    const result = await makeRestoreFileHandler(ctx)({ path: input }, fakeExtra())
    const structured = result.structuredContent as Record<string, unknown>
    expect(structured.format).toBe('txt')
    expect(path.basename(structured.path as string)).toBe('answer-restored.txt')
    expect(await readFile(structured.path as string, 'utf8')).toBe(RESTORED_SENTINEL)
    expect(JSON.stringify(result)).not.toContain('SECRET')
  })

  it('guards the input path', async () => {
    const elsewhere = await tmpDir('stript-elsewhere-')
    const { writeFile } = await import('node:fs/promises')
    const input = path.join(elsewhere, 'answer.txt')
    await writeFile(input, '[PERSON_1]')
    const ctx = makeContext(
      makeSession(backend, broker),
      testConfig({ outputDir: out, allowedDirs: [allowed] }),
    )
    const result = await makeRestoreFileHandler(ctx)({ path: input }, fakeExtra())
    expect(result.isError).toBe(true)
  })
})
