import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { makeFetchResultHandler } from '../src/tools/fetchResult.js'
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
} from './helpers.js'

describe('stript_fetch_result', () => {
  let backend: FakeServer
  let broker: FakeServer

  beforeEach(async () => {
    backend = new FakeServer()
    broker = new FakeServer()
    await backend.start()
    await broker.start()
    wireBroker(broker)
    backend.route('GET', '/api/license/status', (_req, res) => json(res, 200, licensePayload(2)))
    backend.route('GET', '/api/documents/doc1/residual-risk', (_req, res) =>
      json(res, 200, { flagged: true, categories: ['birth_date', 'geo'] }),
    )
  })

  afterEach(async () => {
    await backend.stop()
    await broker.stop()
  })

  async function run(): Promise<Record<string, unknown>> {
    const ctx = makeContext(
      makeSession(backend, broker),
      testConfig({ outputDir: await tmpDir('stript-fetch-out-') }),
    )
    const result = await makeFetchResultHandler(ctx)({ document_id: 'doc1' }, fakeExtra())
    expect(result.isError).toBeUndefined()
    return result.structuredContent as Record<string, unknown>
  }

  /** Chained-wait variant: virtual clock, short review timeout. */
  async function runPolling(timeoutSeconds = 6): Promise<Record<string, unknown>> {
    const clock = virtualClock()
    const ctx = makeContext(
      makeSession(backend, broker),
      testConfig({
        outputDir: await tmpDir('stript-fetch-out-'),
        reviewTimeoutSeconds: timeoutSeconds,
      }),
      { sleep: clock.sleep, now: clock.now },
    )
    const result = await makeFetchResultHandler(ctx)({ document_id: 'doc1' }, fakeExtra())
    expect(result.isError).toBeUndefined()
    return result.structuredContent as Record<string, unknown>
  }

  it('maps a 404 to deleted', async () => {
    const structured = await run()
    expect(structured.status).toBe('deleted')
  })

  it('waits on a detecting document and hands back pending_review on timeout', async () => {
    backend.route('GET', '/api/documents/doc1', (_req, res) =>
      json(res, 200, docPayload({ status: 'detecting' })),
    )
    const structured = await runPolling()
    expect(structured.status).toBe('pending_review')
    expect(structured.reason).toBe('timeout')
    expect(structured.document_id).toBe('doc1')
    expect(structured.next).toBe('stript_fetch_result')
  })

  it('waits on an uploaded document and hands back pending_review on timeout', async () => {
    backend.route('GET', '/api/documents/doc1', (_req, res) =>
      json(res, 200, docPayload({ status: 'uploaded' })),
    )
    const structured = await runPolling()
    expect(structured.status).toBe('pending_review')
    expect(structured.reason).toBe('timeout')
  })

  it('maps detected with zero detections to no_detections', async () => {
    backend.route('GET', '/api/documents/doc1', (_req, res) =>
      json(res, 200, docPayload({ status: 'detected' })),
    )
    backend.route('GET', '/api/documents/doc1/detections', (_req, res) => json(res, 200, []))
    const structured = await run()
    expect(structured.status).toBe('no_detections')
  })

  it('polls a detected document to completion when the Anonymize click lands', async () => {
    let calls = 0
    backend.route('GET', '/api/documents/doc1', (_req, res) => {
      calls += 1
      json(res, 200, docPayload({ status: calls >= 3 ? 'anonymized' : 'detected' }))
    })
    backend.route('GET', '/api/documents/doc1/detections', (_req, res) =>
      json(res, 200, [{ id: 'a' }, { id: 'b' }]),
    )
    backend.route('GET', '/api/documents/doc1/anonymized', (_req, res) =>
      json(res, 200, anonymizePayload()),
    )
    const structured = await runPolling(60)
    expect(structured.status).toBe('anonymized')
    expect(structured.anonymized_text).toBe(
      'Hello [PERSON_1], your account [IBAN_1] is ready.',
    )
    expect(structured.detections_total).toBe(2)
    expect(calls).toBeGreaterThanOrEqual(3)
  })

  it('times out a detected document to the resumable pending_review shape', async () => {
    backend.route('GET', '/api/documents/doc1', (_req, res) =>
      json(res, 200, docPayload({ status: 'detected' })),
    )
    backend.route('GET', '/api/documents/doc1/detections', (_req, res) =>
      json(res, 200, [{ id: 'a' }, { id: 'b' }]),
    )
    const structured = await runPolling()
    expect(structured).toEqual({
      status: 'pending_review',
      reason: 'timeout',
      document_id: 'doc1',
      next: 'stript_fetch_result',
    })
  })

  it('treats a document deleted mid-poll as a decline', async () => {
    let calls = 0
    backend.route('GET', '/api/documents/doc1', (_req, res) => {
      calls += 1
      if (calls >= 2) {
        json(res, 404, { detail: 'not found' })
        return
      }
      json(res, 200, docPayload({ status: 'detected' }))
    })
    backend.route('GET', '/api/documents/doc1/detections', (_req, res) =>
      json(res, 200, [{ id: 'a' }]),
    )
    const structured = await runPolling(60)
    expect(structured.status).toBe('deleted')
    expect(structured.document_id).toBe('doc1')
  })

  it('maps a stale replay to stale with guidance', async () => {
    backend.route('GET', '/api/documents/doc1', (_req, res) =>
      json(res, 200, docPayload({ status: 'anonymized' })),
    )
    backend.route('GET', '/api/documents/doc1/anonymized', (_req, res) =>
      json(res, 409, { error_code: 'ANONYMIZATION_STALE', detail: 'stale' }),
    )
    const ctx = makeContext(
      makeSession(backend, broker),
      testConfig({ outputDir: await tmpDir('stript-fetch-out-') }),
    )
    const result = await makeFetchResultHandler(ctx)({ document_id: 'doc1' }, fakeExtra())
    const structured = result.structuredContent as Record<string, unknown>
    expect(structured.status).toBe('stale')
    expect(JSON.stringify(result.content)).toContain('Finish the review in Stript again')
  })

  it('returns the full result for an anonymized document', async () => {
    backend.route('GET', '/api/documents/doc1', (_req, res) =>
      json(res, 200, docPayload({ status: 'anonymized' })),
    )
    backend.route('GET', '/api/documents/doc1/anonymized', (_req, res) =>
      json(res, 200, anonymizePayload()),
    )
    backend.route('GET', '/api/documents/doc1/detections', (_req, res) =>
      json(res, 200, [{ id: 'a' }, { id: 'b' }, { id: 'c' }]),
    )
    const structured = await run()
    expect(structured.status).toBe('anonymized')
    expect(structured.anonymized_text).toBe(
      'Hello [PERSON_1], your account [IBAN_1] is ready.',
    )
    expect(structured.detections_total).toBe(3)
    expect(structured.residual_risk).toEqual({
      flagged: true,
      categories: ['birth_date', 'geo'],
    })
  })
})

describe('stript_fetch_result without a document_id (no-arg resume)', () => {
  let backend: FakeServer
  let broker: FakeServer

  beforeEach(async () => {
    backend = new FakeServer()
    broker = new FakeServer()
    await backend.start()
    await broker.start()
    wireBroker(broker)
    backend.route('GET', '/api/license/status', (_req, res) => json(res, 200, licensePayload(2)))
  })

  afterEach(async () => {
    await backend.stop()
    await broker.stop()
  })

  function ctx() {
    const clock = virtualClock()
    return makeContext(makeSession(backend, broker), testConfig({ reviewTimeoutSeconds: 6 }), {
      sleep: clock.sleep,
      now: clock.now,
    })
  }

  it('resolves the most recently created document', async () => {
    backend.route('GET', '/api/projects/default/documents', (_req, res) =>
      json(res, 200, [
        docPayload({ id: 'older', status: 'anonymized', created_at: '2026-07-17T00:00:00Z' }),
        docPayload({ id: 'newer', status: 'detected', created_at: '2026-07-20T12:00:00Z' }),
      ]),
    )
    backend.route('GET', '/api/documents/newer', (_req, res) =>
      json(res, 200, docPayload({ id: 'newer', status: 'detected' })),
    )
    backend.route('GET', '/api/documents/newer/detections', (_req, res) =>
      json(res, 200, [{ id: 'd1' }]),
    )
    const result = await makeFetchResultHandler(ctx())({}, fakeExtra())
    const structured = result.structuredContent as Record<string, unknown>
    expect(structured.status).toBe('pending_review')
    expect(structured.document_id).toBe('newer')
  })

  it('also accepts the wrapped documents list shape', async () => {
    backend.route('GET', '/api/projects/default/documents', (_req, res) =>
      json(res, 200, {
        documents: [docPayload({ id: 'only', status: 'detected', created_at: '2026-07-20T12:00:00Z' })],
      }),
    )
    backend.route('GET', '/api/documents/only', (_req, res) =>
      json(res, 200, docPayload({ id: 'only', status: 'detected' })),
    )
    backend.route('GET', '/api/documents/only/detections', (_req, res) =>
      json(res, 200, [{ id: 'd1' }]),
    )
    const result = await makeFetchResultHandler(ctx())({}, fakeExtra())
    const structured = result.structuredContent as Record<string, unknown>
    expect(structured.document_id).toBe('only')
  })

  it('reports nothing_to_fetch on an empty project', async () => {
    backend.route('GET', '/api/projects/default/documents', (_req, res) => json(res, 200, []))
    const result = await makeFetchResultHandler(ctx())({}, fakeExtra())
    const structured = result.structuredContent as Record<string, unknown>
    expect(structured.status).toBe('nothing_to_fetch')
  })
})
