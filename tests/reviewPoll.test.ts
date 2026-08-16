import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { pollForReview } from '../src/reviewPoll.js'
import {
  anonymizePayload,
  docPayload,
  FakeServer,
  json,
  makeSession,
  virtualClock,
  wireBroker,
} from './helpers.js'

describe('review poll state machine (contract section 6)', () => {
  let backend: FakeServer
  let broker: FakeServer

  beforeEach(async () => {
    backend = new FakeServer()
    broker = new FakeServer()
    await backend.start()
    await broker.start()
    wireBroker(broker)
  })

  afterEach(async () => {
    await backend.stop()
    await broker.stop()
  })

  it('resolves once the user has anonymized in the app', async () => {
    let polls = 0
    backend.route('GET', '/api/documents/doc1', (_req, res) => {
      polls += 1
      json(res, 200, docPayload({ status: polls >= 3 ? 'anonymized' : 'detected' }))
    })
    backend.route('GET', '/api/documents/doc1/anonymized', (_req, res) =>
      json(res, 200, anonymizePayload()),
    )
    const clock = virtualClock()
    const session = makeSession(backend, broker)
    const outcome = await pollForReview(session.backend, 'doc1', {
      timeoutMs: 600_000,
      sleep: clock.sleep,
      now: clock.now,
    })
    expect(outcome.status).toBe('anonymized')
    if (outcome.status === 'anonymized') {
      expect(outcome.result.stats.total_replacements).toBe(3)
    }
    expect(polls).toBe(3)
  })

  it('returns pending_review on timeout and polls on the 2 second cadence', async () => {
    backend.route('GET', '/api/documents/doc1', (_req, res) =>
      json(res, 200, docPayload({ status: 'detected' })),
    )
    const clock = virtualClock()
    const session = makeSession(backend, broker)
    const outcome = await pollForReview(session.backend, 'doc1', {
      timeoutMs: 10_000,
      sleep: clock.sleep,
      now: clock.now,
    })
    expect(outcome.status).toBe('pending_review')
    if (outcome.status === 'pending_review') expect(outcome.reason).toBe('timeout')
    // Polls happen at t = 0, 2, 4, 6, 8 and 10 seconds, the 10s check trips
    // the timeout before another sleep.
    expect(backend.requestsFor('GET', '/api/documents/doc1')).toHaveLength(6)
  })

  it('treats a 404 as the user declining (document deleted)', async () => {
    backend.route('GET', '/api/documents/doc1', (_req, res) =>
      json(res, 404, { error_code: 'DOCUMENT_NOT_FOUND', detail: 'gone' }),
    )
    const clock = virtualClock()
    const session = makeSession(backend, broker)
    const outcome = await pollForReview(session.backend, 'doc1', {
      timeoutMs: 10_000,
      sleep: clock.sleep,
      now: clock.now,
    })
    expect(outcome.status).toBe('deleted')
  })

  it('keeps polling through ANONYMIZATION_STALE (re-detect mid-review)', async () => {
    let staleReplies = 0
    backend.route('GET', '/api/documents/doc1', (_req, res) =>
      json(res, 200, docPayload({ status: 'anonymized' })),
    )
    backend.route('GET', '/api/documents/doc1/anonymized', (_req, res) => {
      staleReplies += 1
      if (staleReplies <= 2) {
        json(res, 409, { error_code: 'ANONYMIZATION_STALE', detail: 'stale' })
        return
      }
      json(res, 200, anonymizePayload())
    })
    const clock = virtualClock()
    const session = makeSession(backend, broker)
    const outcome = await pollForReview(session.backend, 'doc1', {
      timeoutMs: 600_000,
      sleep: clock.sleep,
      now: clock.now,
    })
    expect(outcome.status).toBe('anonymized')
    expect(staleReplies).toBe(3)
  })

  it('emits heartbeats on the configured cadence', async () => {
    backend.route('GET', '/api/documents/doc1', (_req, res) =>
      json(res, 200, docPayload({ status: 'detected' })),
    )
    const clock = virtualClock()
    const session = makeSession(backend, broker)
    const heartbeats: number[] = []
    await pollForReview(session.backend, 'doc1', {
      timeoutMs: 20_000,
      heartbeatMs: 5_000,
      sleep: clock.sleep,
      now: clock.now,
      onHeartbeat: (elapsed) => {
        heartbeats.push(elapsed)
      },
    })
    expect(heartbeats.length).toBeGreaterThanOrEqual(2)
  })

  it('resolves to pending_review when the app quits mid-review', async () => {
    backend.route('GET', '/api/documents/doc1', (_req, res) =>
      json(res, 200, docPayload({ status: 'detected' })),
    )
    const clock = virtualClock()
    const session = makeSession(backend, broker)
    let polls = 0
    const originalSleep = clock.sleep
    const outcome = await pollForReview(session.backend, 'doc1', {
      timeoutMs: 600_000,
      sleep: async (ms) => {
        polls += 1
        if (polls === 2) await backend.stop()
        await originalSleep(ms)
      },
      now: clock.now,
    })
    expect(outcome.status).toBe('pending_review')
    if (outcome.status === 'pending_review') expect(outcome.reason).toBe('app_closed')
  })

  it('reports app_closed when the liveness probe fails while the backend lives on', async () => {
    // Dev and Docker shape: the backend keeps answering for a document nobody
    // can review because the app (and its broker) is gone.
    backend.route('GET', '/api/documents/doc1', (_req, res) =>
      json(res, 200, docPayload({ status: 'detected' })),
    )
    const clock = virtualClock()
    const session = makeSession(backend, broker)
    let checks = 0
    const outcome = await pollForReview(session.backend, 'doc1', {
      timeoutMs: 600_000,
      sleep: clock.sleep,
      now: clock.now,
      isAppAlive: async () => {
        checks += 1
        return checks < 3
      },
    })
    expect(outcome.status).toBe('pending_review')
    if (outcome.status === 'pending_review') expect(outcome.reason).toBe('app_closed')
    expect(checks).toBe(3)
  })

  it('a finished review wins over a dead app in the same iteration', async () => {
    backend.route('GET', '/api/documents/doc1', (_req, res) =>
      json(res, 200, docPayload({ status: 'anonymized' })),
    )
    backend.route('GET', '/api/documents/doc1/anonymized', (_req, res) =>
      json(res, 200, anonymizePayload()),
    )
    const clock = virtualClock()
    const session = makeSession(backend, broker)
    const outcome = await pollForReview(session.backend, 'doc1', {
      timeoutMs: 600_000,
      sleep: clock.sleep,
      now: clock.now,
      isAppAlive: async () => false,
    })
    expect(outcome.status).toBe('anonymized')
  })
})
