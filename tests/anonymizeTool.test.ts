import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { UPSELL_TEXT } from '../src/errors.js'
import { makeAnonymizeFileHandler } from '../src/tools/anonymizeFile.js'
import { REDUCED_ACCURACY_NOTE } from '../src/tools/shared.js'
import {
  anonymizePayload,
  docPayload,
  fakeExtra,
  FakeServer,
  json,
  licensePayload,
  makeContext,
  makeSession,
  sseEvent,
  startSse,
  testConfig,
  tmpDir,
  wireBroker,
  type RecordedNotification,
} from './helpers.js'

const ORIGINAL_TEXT = 'Sehr geehrter Herr Hans Krassnig, Ottakringer Str. 9'

describe('stript_anonymize_file', () => {
  let backend: FakeServer
  let broker: FakeServer
  let allowed: string
  let out: string
  let inputFile: string
  let docStatus: string

  beforeEach(async () => {
    backend = new FakeServer()
    broker = new FakeServer()
    await backend.start()
    await broker.start()
    wireBroker(broker, { permit: 'permit-7' })
    allowed = await tmpDir('stript-anon-allowed-')
    out = await tmpDir('stript-anon-out-')
    inputFile = path.join(allowed, 'brief.txt')
    await writeFile(inputFile, ORIGINAL_TEXT)
    docStatus = 'uploaded'

    backend.route('GET', '/api/license/status', (_req, res) => json(res, 200, licensePayload(3)))
    backend.route('GET', '/api/documents/doc1', (_req, res) =>
      json(res, 200, docPayload({ status: docStatus, text: ORIGINAL_TEXT })),
    )
    backend.route('POST', '/api/documents/upload', (_req, res) =>
      json(res, 200, docPayload({ text: ORIGINAL_TEXT })),
    )
    backend.route('GET', '/api/settings', (_req, res) =>
      json(res, 200, {
        default_threshold: '0.6',
        default_pii_types: ['PERSON', 'EMAIL', 'ADDRESS'],
      }),
    )
    backend.route('POST', '/api/documents/doc1/detect', (_req, res) => {
      startSse(res)
      res.write(sseEvent('stage_start', { stage: 'patterns', message: 'Precision scan' }))
      res.write(
        sseEvent('complete', {
          total_detections: 3,
          duration_ms: 500,
          completion_receipt: 'receipt-detect',
        }),
      )
      res.end()
    })
    backend.route('POST', '/api/documents/doc1/anonymize', (_req, res) =>
      json(res, 200, anonymizePayload({ completion_receipt: 'receipt-anon' })),
    )
    backend.route('GET', '/api/documents/doc1/residual-risk', (_req, res) =>
      json(res, 200, { flagged: false, categories: [] }),
    )
    backend.route('GET', '/api/documents/doc1/detections', (_req, res) =>
      json(res, 200, [{ id: 'd1' }, { id: 'd2' }, { id: 'd3' }]),
    )
    backend.route('POST', '/api/license/evaluation-receipts/ack', (_req, res) =>
      json(res, 200, { status: 'ok' }),
    )
  })

  afterEach(async () => {
    await backend.stop()
    await broker.stop()
  })

  function ctx(overrides: Parameters<typeof testConfig>[0] = {}) {
    return makeContext(
      makeSession(backend, broker),
      testConfig({ allowedDirs: [allowed], outputDir: out, ...overrides }),
      { pollIntervalMs: 5, heartbeatMs: 10 },
    )
  }

  it('auto mode: upload, permit, detect, anonymize with saved settings, result', async () => {
    const notifications: RecordedNotification[] = []
    const handler = makeAnonymizeFileHandler(ctx())
    const result = await handler({ path: inputFile, mode: 'auto' }, fakeExtra(notifications))

    expect(result.isError).toBeUndefined()
    const structured = result.structuredContent as Record<string, unknown>
    expect(structured.status).toBe('anonymized')
    expect(structured.anonymized_text).toBe(
      'Hello [PERSON_1], your account [IBAN_1] is ready.',
    )
    expect(structured.detections_total).toBe(3)
    expect(structured.replacements).toBe(3)
    expect(structured.types).toEqual({ PERSON: 2, IBAN: 1 })
    expect(structured.evaluation).toEqual({ credit_status: 'unprocessed', remaining: 3 })
    expect(structured.residual_risk).toEqual({ flagged: false, categories: [] })

    // The tool text carries the card-relevant facts in the stable shape the
    // MCP Apps widgets parse (hosts that forward only content).
    const text = (result.content[0] as { text: string }).text
    expect(text).toContain('Stript anonymized brief.txt. 3 replacements, 3 detections.')
    expect(text).toContain('Types: PERSON 2, IBAN 1.')
    expect(text).toContain('3 of 5 Free Evaluation documents remaining.')

    // The original document text never leaks into the result.
    expect(JSON.stringify(result)).not.toContain('Krassnig')

    // Upload carried the project id.
    const uploads = backend.requestsFor('POST', '/api/documents/upload')
    expect(uploads[0]?.body).toContain('name="project_id"')
    expect(uploads[0]?.body).toContain('default')

    // Permit attached to detect AND anonymize.
    const detects = backend.requestsFor('POST', '/api/documents/doc1/detect')
    expect(detects[0]?.headers['x-stript-evaluation-permit']).toBe('permit-7')
    const anonymizes = backend.requestsFor('POST', '/api/documents/doc1/anonymize')
    expect(anonymizes[0]?.headers['x-stript-evaluation-permit']).toBe('permit-7')

    // Anonymize used the saved app settings.
    const anonymizeBody = JSON.parse(anonymizes[0]?.body ?? '{}') as Record<string, unknown>
    expect(anonymizeBody.enabled_types).toEqual(['PERSON', 'EMAIL', 'ADDRESS'])
    expect(anonymizeBody.confidence_threshold).toBe(0.6)

    // Receipts finalized from the SSE complete AND the anonymize response.
    const finalizeBodies = broker
      .requestsFor('POST', '/v1/finalize')
      .map((r) => (JSON.parse(r.body) as { receipt: string }).receipt)
    expect(finalizeBodies).toEqual(['receipt-detect', 'receipt-anon'])

    // Progress notifications flowed (the request carried a progressToken).
    expect(notifications.length).toBeGreaterThan(0)
  })

  it('auto mode: a degraded run surfaces the reduced-accuracy note and reasons', async () => {
    backend.route('POST', '/api/documents/doc1/detect', (_req, res) => {
      startSse(res)
      res.write(
        sseEvent('stage_warning', {
          stage: 'slm',
          reason: 'slm_skipped_low_memory',
          message: 'Running with reduced accuracy: not enough free memory.',
        }),
      )
      res.write(sseEvent('complete', { total_detections: 3, duration_ms: 500 }))
      res.end()
    })
    const handler = makeAnonymizeFileHandler(ctx())
    const result = await handler({ path: inputFile, mode: 'auto' }, fakeExtra())

    expect(result.isError).toBeUndefined()
    const structured = result.structuredContent as Record<string, unknown>
    expect(structured.status).toBe('anonymized')
    expect(structured.reduced_accuracy).toBe(true)
    expect(structured.degraded_reasons).toEqual(['slm_skipped_low_memory'])
    const warnings = structured.warnings as string[]
    expect(warnings[0]).toBe(REDUCED_ACCURACY_NOTE)
    expect(warnings).toContain('Running with reduced accuracy: not enough free memory.')
    // The human-readable text carries the calm note prominently.
    const text = (result.content[0] as { text: string }).text
    expect(text).toContain(REDUCED_ACCURACY_NOTE)
  })

  it('auto mode: a degraded zero-detection run still carries the note', async () => {
    backend.route('POST', '/api/documents/doc1/detect', (_req, res) => {
      startSse(res)
      res.write(sseEvent('stage_warning', { stage: 'ner', reason: 'model_load_failed', message: '' }))
      res.write(sseEvent('complete', { total_detections: 0, duration_ms: 100 }))
      res.end()
    })
    const handler = makeAnonymizeFileHandler(ctx())
    const result = await handler({ path: inputFile, mode: 'auto' }, fakeExtra())
    const structured = result.structuredContent as Record<string, unknown>
    expect(structured.status).toBe('no_detections')
    expect(structured.reduced_accuracy).toBe(true)
    expect(structured.degraded_reasons).toEqual(['model_load_failed'])
    const text = (result.content[0] as { text: string }).text
    expect(text).toContain(REDUCED_ACCURACY_NOTE)
    expect(JSON.stringify(result)).not.toContain('Krassnig')
  })

  it('auto mode: a clean run sets no reduced-accuracy fields', async () => {
    const handler = makeAnonymizeFileHandler(ctx())
    const result = await handler({ path: inputFile, mode: 'auto' }, fakeExtra())
    const structured = result.structuredContent as Record<string, unknown>
    expect(structured.reduced_accuracy).toBeUndefined()
    expect(structured.degraded_reasons).toBeUndefined()
    const text = (result.content[0] as { text: string }).text
    expect(text).not.toContain('reduced accuracy')
  })

  it('auto mode: zero detections returns a notice, never the text', async () => {
    backend.route('POST', '/api/documents/doc1/detect', (_req, res) => {
      startSse(res)
      res.write(sseEvent('complete', { total_detections: 0, duration_ms: 100 }))
      res.end()
    })
    const handler = makeAnonymizeFileHandler(ctx())
    const result = await handler({ path: inputFile, mode: 'auto' }, fakeExtra())
    const structured = result.structuredContent as Record<string, unknown>
    expect(structured.status).toBe('no_detections')
    expect(structured.anonymized_text).toBeUndefined()
    expect(backend.requestsFor('POST', '/api/documents/doc1/anonymize')).toHaveLength(0)
    expect(JSON.stringify(result)).not.toContain('Krassnig')
  })

  it('auto mode: zero replacements returns counts, never the text', async () => {
    backend.route('POST', '/api/documents/doc1/anonymize', (_req, res) =>
      json(
        res,
        200,
        anonymizePayload({
          anonymized_text: ORIGINAL_TEXT,
          mapping: [],
          stats: { total_replacements: 0, unique_entities: 0, pii_types_found: [] },
        }),
      ),
    )
    const handler = makeAnonymizeFileHandler(ctx())
    const result = await handler({ path: inputFile, mode: 'auto' }, fakeExtra())
    const structured = result.structuredContent as Record<string, unknown>
    expect(structured.status).toBe('no_replacements')
    expect(structured.anonymized_text).toBeUndefined()
    // The unmodified text IS the original document, it must not leak.
    expect(JSON.stringify(result)).not.toContain('Krassnig')
  })

  it('auto mode: oversized anonymized text goes to the output directory', async () => {
    const bigText = `[PERSON_1] ${'x'.repeat(100_001)}`
    backend.route('POST', '/api/documents/doc1/anonymize', (_req, res) =>
      json(res, 200, anonymizePayload({ anonymized_text: bigText })),
    )
    const handler = makeAnonymizeFileHandler(ctx())
    const result = await handler({ path: inputFile, mode: 'auto' }, fakeExtra())
    const structured = result.structuredContent as Record<string, unknown>
    expect(structured.status).toBe('anonymized')
    expect(structured.anonymized_text).toBeUndefined()
    const outputFile = structured.output_file as string
    expect(path.dirname(outputFile)).toBe(out)
    expect(await readFile(outputFile, 'utf8')).toBe(bigText)
  })

  it('auto mode: 402 at detect surfaces the honest upsell', async () => {
    backend.route('POST', '/api/documents/doc1/detect', (_req, res) =>
      json(res, 402, { error_code: 'USAGE_LIMIT_EXCEEDED', detail: 'limit' }),
    )
    const handler = makeAnonymizeFileHandler(ctx())
    const result = await handler({ path: inputFile, mode: 'auto' }, fakeExtra())
    expect(result.isError).toBe(true)
    expect(result.content[0]).toMatchObject({ type: 'text', text: UPSELL_TEXT })
  })

  it('refuses a path outside the allowed directories', async () => {
    const elsewhere = await tmpDir('stript-anon-elsewhere-')
    const file = path.join(elsewhere, 'brief.txt')
    await writeFile(file, ORIGINAL_TEXT)
    const handler = makeAnonymizeFileHandler(ctx())
    const result = await handler({ path: file, mode: 'auto' }, fakeExtra())
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('outside the allowed folders')
  })

  it('review mode: opens the document in Stript, mints nothing, waits for the click', async () => {
    let polls = 0
    backend.route('GET', '/api/documents/doc1', (_req, res) => {
      polls += 1
      json(res, 200, docPayload({ status: polls >= 3 ? 'anonymized' : 'detected' }))
    })
    backend.route('GET', '/api/documents/doc1/anonymized', (_req, res) =>
      json(res, 200, anonymizePayload()),
    )
    const handler = makeAnonymizeFileHandler(ctx())
    const result = await handler({ path: inputFile, mode: 'review' }, fakeExtra())

    expect(result.isError).toBeUndefined()
    const structured = result.structuredContent as Record<string, unknown>
    expect(structured.status).toBe('anonymized')
    expect(structured.anonymized_text).toBe(
      'Hello [PERSON_1], your account [IBAN_1] is ready.',
    )
    // The handoff went through the broker and the bridge minted no permit
    // and ran no detection itself.
    expect(broker.requestsFor('POST', '/v1/open-document')).toHaveLength(1)
    expect(broker.requestsFor('POST', '/v1/permit')).toHaveLength(0)
    expect(backend.requestsFor('POST', '/api/documents/doc1/detect')).toHaveLength(0)
  })

  it('review mode: timeout returns pending_review with resume guidance', async () => {
    backend.route('GET', '/api/documents/doc1', (_req, res) =>
      json(res, 200, docPayload({ status: 'detected' })),
    )
    const handler = makeAnonymizeFileHandler(ctx({ reviewTimeoutSeconds: 0.02 }))
    const result = await handler({ path: inputFile, mode: 'review' }, fakeExtra())
    const structured = result.structuredContent as Record<string, unknown>
    expect(structured.status).toBe('pending_review')
    expect(structured.document_id).toBe('doc1')
    expect(structured.next).toBe('stript_fetch_result')
    expect(JSON.stringify(result.content)).toContain('stript_fetch_result')
  })

  it('review mode: a deleted document is treated as a decline', async () => {
    backend.route('GET', '/api/documents/doc1', (_req, res) =>
      json(res, 404, { error_code: 'DOCUMENT_NOT_FOUND', detail: 'gone' }),
    )
    const handler = makeAnonymizeFileHandler(ctx())
    const result = await handler({ path: inputFile, mode: 'review' }, fakeExtra())
    const structured = result.structuredContent as Record<string, unknown>
    expect(structured.status).toBe('deleted')
  })

  it('review mode at the lifetime cap returns the upsell without opening the app', async () => {
    backend.route('GET', '/api/license/status', (_req, res) => json(res, 200, licensePayload(0)))
    const handler = makeAnonymizeFileHandler(ctx())
    const result = await handler({ path: inputFile, mode: 'review' }, fakeExtra())
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('5 evaluation documents')
    // The doomed review never opened a document in the app.
    expect(broker.requestsFor('POST', '/v1/open-document')).toHaveLength(0)
  })
})
