/** Round-trip tests for the card text formats.
 *
 * Claude Desktop forwards only `content` to the MCP Apps widget, so the
 * cards parse the tool TEXT as their third payload source. These tests
 * build each text through the REAL result builders and parse it back with
 * the REAL widget parser, asserting the render-relevant fields match the
 * structured payload. Any drift between builder and parser breaks here. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

import { parseRestoreText, parseResultText, parseStatusText } from '../src/cardText.js'
import { pendingReviewResult } from '../src/tools/anonymizeFlow.js'
import { makeFetchResultHandler } from '../src/tools/fetchResult.js'
import { makeRestoreHandler } from '../src/tools/restore.js'
import { makeRestoreFileHandler } from '../src/tools/restoreFile.js'
import {
  buildAnonymizeResult,
  buildNoDetectionsResult,
  INLINE_TEXT_LIMIT,
} from '../src/tools/shared.js'
import { makeStatusHandler } from '../src/tools/status.js'
import type { AnonymizeResponse } from '../src/types.js'
import {
  anonymizePayload,
  docPayload,
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

vi.mock('../src/clipboard.js', () => ({
  readClipboard: vi.fn(async () => ''),
  writeClipboard: vi.fn(async () => undefined),
}))

function textOf(result: CallToolResult): string {
  const entry = result.content.find(
    (c): c is { type: 'text'; text: string } => c.type === 'text',
  )
  expect(entry).toBeDefined()
  return entry?.text ?? ''
}

function structuredOf(result: CallToolResult): Record<string, unknown> {
  return result.structuredContent as Record<string, unknown>
}

describe('result text round trip', () => {
  let backend: FakeServer
  let broker: FakeServer
  let out: string

  beforeEach(async () => {
    backend = new FakeServer()
    broker = new FakeServer()
    await backend.start()
    await broker.start()
    wireBroker(broker)
    out = await tmpDir('stript-cardtext-out-')
    backend.route('GET', '/api/license/status', (_req, res) => json(res, 200, licensePayload(4)))
    backend.route('GET', '/api/documents/doc1', (_req, res) =>
      json(res, 200, docPayload({ status: 'anonymized' })),
    )
    backend.route('GET', '/api/documents/doc1/residual-risk', (_req, res) =>
      json(res, 200, { flagged: false, categories: [] }),
    )
  })

  afterEach(async () => {
    await backend.stop()
    await broker.stop()
  })

  function session() {
    return makeSession(backend, broker)
  }

  function config() {
    return testConfig({ outputDir: out })
  }

  async function buildInline(
    overrides: Record<string, unknown> = {},
    warnings: string[] = [],
    stageWarnings: Array<{ stage: string; reason: string; message: string }> = [],
  ): Promise<CallToolResult> {
    return buildAnonymizeResult(
      config(),
      session(),
      'doc1',
      anonymizePayload(overrides) as unknown as AnonymizeResponse,
      3,
      warnings,
      'brief.txt',
      stageWarnings,
    )
  }

  it('anonymized inline: counts, types, evaluation, and warnings survive the parse', async () => {
    const result = await buildInline({}, ['Scanned pages were read with OCR.'])
    const parsed = parseResultText(textOf(result))
    const structured = structuredOf(result)

    expect(parsed).toBeDefined()
    expect(parsed?.status).toBe('anonymized')
    expect(parsed?.replacements).toBe(structured.replacements)
    expect(parsed?.detections_total).toBe(structured.detections_total)
    expect(parsed?.types).toEqual(structured.types)
    expect((parsed?.evaluation as { remaining: number }).remaining).toBe(
      (structured.evaluation as { remaining: number }).remaining,
    )
    expect(parsed?.warnings).toEqual(structured.warnings)
    // The anonymized text is returned for the card (user decision
    // 2026-07-21), byte-equal to the structured field.
    expect(parsed?.anonymized_text).toBe(structured.anonymized_text)
  })

  it('residual risk and reduced accuracy survive the parse', async () => {
    backend.route('GET', '/api/documents/doc1/residual-risk', (_req, res) =>
      json(res, 200, { flagged: true, categories: ['birth_date', 'geo'] }),
    )
    const result = await buildInline({}, [], [
      { stage: 'slm', reason: 'slm_skipped_low_memory', message: 'not enough free memory' },
    ])
    const parsed = parseResultText(textOf(result))
    const structured = structuredOf(result)

    expect(parsed?.reduced_accuracy).toBe(true)
    expect(parsed?.residual_risk).toEqual({ flagged: true, categories: ['birth_date', 'geo'] })
    expect(structured.residual_risk).toEqual(parsed?.residual_risk)
    expect(parsed?.warnings).toEqual(structured.warnings)
  })

  it('pro tier reads as unlimited', async () => {
    backend.route('GET', '/api/license/status', (_req, res) => json(res, 200, licensePayload(-1)))
    const result = await buildInline()
    const parsed = parseResultText(textOf(result))
    expect((parsed?.evaluation as { remaining: number }).remaining).toBe(-1)
  })

  it('oversized text: output path and counts survive the parse', async () => {
    const big = 'x'.repeat(INLINE_TEXT_LIMIT + 1)
    const result = await buildInline({ anonymized_text: big })
    const parsed = parseResultText(textOf(result))
    const structured = structuredOf(result)

    expect(parsed?.status).toBe('anonymized')
    expect(parsed?.output_file).toBe(structured.output_file)
    expect(parsed?.replacements).toBe(structured.replacements)
    expect(parsed?.types).toEqual(structured.types)
    expect((parsed?.evaluation as { remaining: number }).remaining).toBe(4)
  })

  it('no_replacements survives the parse without leaking body copy as warnings', async () => {
    const result = await buildInline({
      stats: { total_replacements: 0, unique_entities: 0, pii_types_found: [] },
    })
    const parsed = parseResultText(textOf(result))
    expect(parsed?.status).toBe('no_replacements')
    expect((parsed?.evaluation as { remaining: number }).remaining).toBe(4)
    expect(parsed?.warnings).toBeUndefined()
  })

  it('no_detections survives the parse', async () => {
    const result = await buildNoDetectionsResult(config(), session(), 'doc1', [], 'brief.txt')
    const parsed = parseResultText(textOf(result))
    expect(parsed?.status).toBe('no_detections')
    expect((parsed?.evaluation as { remaining: number }).remaining).toBe(4)
    expect(parsed?.warnings).toBeUndefined()
  })

  it('pending_review parses with the document id', () => {
    for (const reason of ['timeout', 'app_closed'] as const) {
      const result = pendingReviewResult('doc1', reason)
      const parsed = parseResultText(textOf(result))
      expect(parsed?.status).toBe('pending_review')
      expect(parsed?.document_id).toBe('doc1')
    }
  })

  it('transient fetch states parse to their status', async () => {
    const clock = virtualClock()
    const ctx = makeContext(
      session(),
      { ...config(), reviewTimeoutSeconds: 6 },
      { sleep: clock.sleep, now: clock.now },
    )
    const handler = makeFetchResultHandler(ctx)

    backend.route('GET', '/api/documents/doc1', (_req, res) =>
      json(res, 200, docPayload({ status: 'error' })),
    )
    const errored = await handler({ document_id: 'doc1' }, fakeExtra())
    const parsedError = parseResultText(textOf(errored))
    expect(parsedError?.status).toBe('error')
    expect(parsedError?.status).toBe(structuredOf(errored).status)

    // In review (detected with stored detections) and detecting both wait
    // for the review now and time out to the resumable pending_review.
    for (const docStatus of ['detecting', 'detected']) {
      backend.route('GET', '/api/documents/doc1', (_req, res) =>
        json(res, 200, docPayload({ status: docStatus })),
      )
      backend.route('GET', '/api/documents/doc1/detections', (_req, res) =>
        json(res, 200, [{ id: 'd1' }]),
      )
      const pending = await handler({ document_id: 'doc1' }, fakeExtra())
      const parsed = parseResultText(textOf(pending))
      expect(parsed?.status, docStatus).toBe('pending_review')
      expect(parsed?.document_id, docStatus).toBe('doc1')
      expect(parsed?.status, docStatus).toBe(structuredOf(pending).status)
    }

    // Deleted: the document 404s.
    const deleted = await handler({ document_id: 'gone' }, fakeExtra())
    expect(parseResultText(textOf(deleted))?.status).toBe('deleted')
  })

  it('unrecognized text parses to undefined, the card falls back to raw text', () => {
    expect(parseResultText('Something completely different.')).toBeUndefined()
    expect(parseResultText('')).toBeUndefined()
  })
})

describe('status text round trip', () => {
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

  it('running status survives the parse', async () => {
    const dataDir = await tmpDir('stript-cardtext-data-')
    await writeDiscoveryFile(dataDir, backend.port, broker.port)
    const ctx = makeContext(makeSession(backend, broker), testConfig({ dataDir }))
    const result = await makeStatusHandler(ctx)({}, fakeExtra())
    const parsed = parseStatusText(textOf(result))
    const structured = structuredOf(result)

    expect(parsed).toMatchObject({
      app_running: true,
      integration_enabled: true,
      app_version: structured.app_version,
      tier: structured.tier,
      evaluation_remaining: structured.evaluation_remaining,
      models_ready: structured.models_ready,
    })
  })

  it('pro tier and loading models survive the parse', async () => {
    backend.route('GET', '/api/license/status', (_req, res) => json(res, 200, licensePayload(-1)))
    backend.route('GET', '/api/health', (_req, res) =>
      json(res, 200, {
        status: 'ok',
        version: '1.1.0',
        compute_profile: 'standard',
        models_loaded: { ner: false },
      }),
    )
    const dataDir = await tmpDir('stript-cardtext-data-')
    await writeDiscoveryFile(dataDir, backend.port, broker.port)
    const ctx = makeContext(makeSession(backend, broker), testConfig({ dataDir }))
    const result = await makeStatusHandler(ctx)({}, fakeExtra())
    const parsed = parseStatusText(textOf(result))
    expect(parsed?.evaluation_remaining).toBe(-1)
    expect(parsed?.models_ready).toBe(false)
  })

  it('a not-running text parses to guidance, matching the structured payload', async () => {
    const dataDir = await tmpDir('stript-cardtext-data-')
    const ctx = makeContext(makeSession(backend, broker), testConfig({ dataDir }))
    const result = await makeStatusHandler(ctx)({}, fakeExtra())
    const parsed = parseStatusText(textOf(result))
    const structured = structuredOf(result)
    expect(parsed).toEqual({
      app_running: false,
      integration_enabled: false,
      guidance: structured.guidance,
    })
  })
})

describe('restore text round trip', () => {
  let backend: FakeServer
  let broker: FakeServer
  let out: string

  beforeEach(async () => {
    backend = new FakeServer()
    broker = new FakeServer()
    await backend.start()
    await broker.start()
    wireBroker(broker)
    out = await tmpDir('stript-cardtext-restore-')
    backend.route('POST', '/api/anonymization/deanonymize', (_req, res) =>
      json(res, 200, {
        restored_text: 'SECRET restored',
        replacements_made: 2,
        unmatched_placeholders: ['[PERSON_9]', '[IBAN_3]'],
        ambiguous_skipped: [],
        exact_restore: true,
      }),
    )
  })

  afterEach(async () => {
    await backend.stop()
    await broker.stop()
    vi.clearAllMocks()
  })

  it('clipboard restore survives the parse', async () => {
    const ctx = makeContext(makeSession(backend, broker), testConfig({ outputDir: out }))
    const result = await makeRestoreHandler(ctx)(
      { text: 'Dear [PERSON_1]', destination: 'clipboard' },
      fakeExtra(),
    )
    const parsed = parseRestoreText(textOf(result))
    const structured = structuredOf(result)

    expect(parsed?.replacements_made).toBe(structured.replacements_made)
    expect(parsed?.destination).toBe('clipboard')
    expect(parsed?.unmatched_placeholders).toEqual(structured.unmatched_placeholders)
    expect(parsed?.exact_restore).toBe(true)
    expect(JSON.stringify(parsed)).not.toContain('SECRET')
  })

  it('file restore survives the parse with the path', async () => {
    const ctx = makeContext(makeSession(backend, broker), testConfig({ outputDir: out }))
    const result = await makeRestoreHandler(ctx)(
      { text: 'Dear [PERSON_1]', destination: 'file', filename: 'my letter.txt' },
      fakeExtra(),
    )
    const parsed = parseRestoreText(textOf(result))
    const structured = structuredOf(result)
    expect(parsed?.destination).toBe('file')
    expect(parsed?.path).toBe(structured.path)
  })

  it('restore_file survives the parse with path, format, and warnings', async () => {
    const allowed = await tmpDir('stript-cardtext-allowed-')
    const { writeFile } = await import('node:fs/promises')
    const path = await import('node:path')
    const input = path.join(allowed, 'answer.txt')
    await writeFile(input, 'Dear [PERSON_1]')
    backend.route('POST', '/api/anonymization/deanonymize-file', (_req, res) =>
      json(res, 200, {
        restored_text: 'SECRET restored',
        replacements_made: 5,
        unmatched_placeholders: ['[PERSON_9]'],
        ambiguous_skipped: [],
        exact_restore: true,
        warnings: [{ code: 'X', message: 'A format note from the backend.' }],
        download: {
          filename: 'answer restored.docx',
          format: 'docx',
          file_base64: Buffer.from('fake docx').toString('base64'),
        },
      }),
    )
    const ctx = makeContext(
      makeSession(backend, broker),
      testConfig({ outputDir: out, allowedDirs: [allowed] }),
    )
    const result = await makeRestoreFileHandler(ctx)({ path: input }, fakeExtra())
    const parsed = parseRestoreText(textOf(result))
    const structured = structuredOf(result)

    expect(parsed?.replacements_made).toBe(5)
    expect(parsed?.destination).toBe('file')
    expect(parsed?.path).toBe(structured.path)
    expect(parsed?.format).toBe('docx')
    expect(parsed?.exact_restore).toBe(true)
    expect(parsed?.unmatched_placeholders).toEqual(['[PERSON_9]'])
    expect(parsed?.warnings).toEqual(['A format note from the backend.'])
  })

  it('unrecognized text parses to undefined', () => {
    expect(parseRestoreText('Something else entirely.')).toBeUndefined()
  })
})
