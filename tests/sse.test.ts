import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { StriptApiError } from '../src/errors.js'
import { runDetection } from '../src/detect.js'
import {
  docPayload,
  FakeServer,
  json,
  licensePayload,
  makeSession,
  sseEvent,
  startSse,
  wireBroker,
} from './helpers.js'

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe('detect SSE consumption', () => {
  let backend: FakeServer
  let broker: FakeServer

  beforeEach(async () => {
    backend = new FakeServer()
    broker = new FakeServer()
    await backend.start()
    await broker.start()
    wireBroker(broker)
    backend.route('GET', '/api/license/status', (_req, res) => json(res, 200, licensePayload(3)))
    backend.route('GET', '/api/documents/doc1', (_req, res) => json(res, 200, docPayload()))
    backend.route('POST', '/api/license/evaluation-receipts/ack', (_req, res) =>
      json(res, 200, { status: 'ok' }),
    )
  })

  afterEach(async () => {
    await backend.stop()
    await broker.stop()
  })

  it('parses events split across arbitrary transport chunks', async () => {
    const payload =
      sseEvent('stage_start', { stage: 'patterns', message: 'Precision scan' }) +
      sseEvent('detections_batch', { stage: 'patterns', detections: [{ id: 'a' }] }) +
      sseEvent('complete', { total_detections: 7, duration_ms: 1200 })
    backend.route('POST', '/api/documents/doc1/detect', async (_req, res) => {
      startSse(res)
      // Write in awkward chunks that split lines and event boundaries.
      for (let i = 0; i < payload.length; i += 7) {
        res.write(payload.slice(i, i + 7))
        await sleep(1)
      }
      res.end()
    })
    const session = makeSession(backend, broker)
    const events: Array<{ event: string; data: string }> = []
    for await (const evt of session.backend.detectStream('doc1', null)) {
      events.push(evt)
    }
    expect(events.map((e) => e.event)).toEqual(['stage_start', 'detections_batch', 'complete'])
    expect(JSON.parse(events[2]?.data ?? '{}')).toEqual({
      total_detections: 7,
      duration_ms: 1200,
    })
  })

  it('completes with totals and finalizes the completion receipt', async () => {
    backend.route('POST', '/api/documents/doc1/detect', (_req, res) => {
      startSse(res)
      res.write(sseEvent('stage_start', { stage: 'patterns', message: 'Precision scan' }))
      res.write(
        sseEvent('complete', {
          total_detections: 4,
          duration_ms: 900,
          completion_receipt: 'receipt-detect',
        }),
      )
      res.end()
    })
    const session = makeSession(backend, broker)
    const progress: string[] = []
    const outcome = await runDetection(session.backend, session.metering, 'doc1', 'permit-1', (p) => {
      progress.push(p.message)
    })
    expect(outcome.totalDetections).toBe(4)
    expect(outcome.durationMs).toBe(900)
    expect(progress).toContain('Precision scan')
    const finalizes = broker.requestsFor('POST', '/v1/finalize')
    expect(finalizes).toHaveLength(1)
    expect(JSON.parse(finalizes[0]?.body ?? '{}')).toEqual({ receipt: 'receipt-detect' })
    // Permit attached to the detect request.
    const detects = backend.requestsFor('POST', '/api/documents/doc1/detect')
    expect(detects[0]?.headers['x-stript-evaluation-permit']).toBe('permit-1')
  })

  it('collects stage warnings with their structured reason and stage', async () => {
    backend.route('POST', '/api/documents/doc1/detect', (_req, res) => {
      startSse(res)
      res.write(
        sseEvent('stage_warning', { stage: 'slm', reason: 'low_memory', message: 'Reduced accuracy' }),
      )
      res.write(
        sseEvent('stage_warning', { stage: 'ner', reason: 'model_load_failed', message: 'Model unavailable' }),
      )
      res.write(sseEvent('complete', { total_detections: 1, duration_ms: 10 }))
      res.end()
    })
    const session = makeSession(backend, broker)
    const outcome = await runDetection(session.backend, session.metering, 'doc1', null)
    expect(outcome.warnings).toEqual(['Reduced accuracy', 'Model unavailable'])
    expect(outcome.stageWarnings).toEqual([
      { stage: 'slm', reason: 'low_memory', message: 'Reduced accuracy' },
      { stage: 'ner', reason: 'model_load_failed', message: 'Model unavailable' },
    ])
  })

  it('captures a reason-only stage warning', async () => {
    backend.route('POST', '/api/documents/doc1/detect', (_req, res) => {
      startSse(res)
      res.write(sseEvent('stage_warning', { stage: 'slm', reason: 'slm_skipped_low_memory' }))
      res.write(sseEvent('complete', { total_detections: 1, duration_ms: 10 }))
      res.end()
    })
    const session = makeSession(backend, broker)
    const outcome = await runDetection(session.backend, session.metering, 'doc1', null)
    expect(outcome.warnings).toEqual([])
    expect(outcome.stageWarnings).toEqual([
      { stage: 'slm', reason: 'slm_skipped_low_memory', message: '' },
    ])
  })

  it('a clean run carries no stage warnings', async () => {
    backend.route('POST', '/api/documents/doc1/detect', (_req, res) => {
      startSse(res)
      res.write(sseEvent('complete', { total_detections: 1, duration_ms: 10 }))
      res.end()
    })
    const session = makeSession(backend, broker)
    const outcome = await runDetection(session.backend, session.metering, 'doc1', null)
    expect(outcome.stageWarnings).toEqual([])
  })

  it('treats the error event as a failure and still finalizes its receipt', async () => {
    backend.route('POST', '/api/documents/doc1/detect', (_req, res) => {
      startSse(res)
      res.write(
        sseEvent('error', { message: 'Detection failed inside the pipeline', completion_receipt: 'receipt-err' }),
      )
      res.end()
    })
    const session = makeSession(backend, broker)
    await expect(
      runDetection(session.backend, session.metering, 'doc1', null),
    ).rejects.toThrow('Detection failed inside the pipeline')
    const finalizes = broker.requestsFor('POST', '/v1/finalize')
    expect(finalizes).toHaveLength(1)
    expect(JSON.parse(finalizes[0]?.body ?? '{}')).toEqual({ receipt: 'receipt-err' })
  })

  it('treats a stream that ends without a terminal event as a failure', async () => {
    backend.route('POST', '/api/documents/doc1/detect', (_req, res) => {
      startSse(res)
      res.write(sseEvent('stage_start', { stage: 'patterns', message: 'Precision scan' }))
      res.end()
    })
    const session = makeSession(backend, broker)
    await expect(
      runDetection(session.backend, session.metering, 'doc1', null),
    ).rejects.toThrow('ended before it finished')
  })

  it('retries exactly once with force=true on a 409', async () => {
    let calls = 0
    backend.route('POST', '/api/documents/doc1/detect', (req, res) => {
      calls += 1
      if (calls === 1) {
        expect(req.url).not.toContain('force=true')
        json(res, 409, { error_code: 'DETECTION_IN_PROGRESS', detail: 'already running' })
        return
      }
      expect(req.url).toContain('force=true')
      startSse(res)
      res.write(sseEvent('complete', { total_detections: 2, duration_ms: 5 }))
      res.end()
    })
    const session = makeSession(backend, broker)
    const outcome = await runDetection(session.backend, session.metering, 'doc1', null)
    expect(outcome.totalDetections).toBe(2)
    expect(calls).toBe(2)
  })

  it('gives up after the single force retry when the 409 persists', async () => {
    backend.route('POST', '/api/documents/doc1/detect', (_req, res) => {
      json(res, 409, { error_code: 'DETECTION_IN_PROGRESS', detail: 'still running' })
    })
    const session = makeSession(backend, broker)
    const failure = await runDetection(session.backend, session.metering, 'doc1', null).catch(
      (e: unknown) => e,
    )
    expect(failure).toBeInstanceOf(StriptApiError)
    expect((failure as StriptApiError).errorCode).toBe('DETECTION_IN_PROGRESS')
    expect(backend.requestsFor('POST', '/api/documents/doc1/detect')).toHaveLength(2)
  })
})
