import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ENROLLMENT_GUIDANCE, EvaluationLimitError, UPSELL_TEXT } from '../src/errors.js'
import {
  docPayload,
  FakeServer,
  json,
  licensePayload,
  makeSession,
  wireBroker,
} from './helpers.js'

describe('metering mirror (contract section 5)', () => {
  let backend: FakeServer
  let broker: FakeServer

  beforeEach(async () => {
    backend = new FakeServer()
    broker = new FakeServer()
    await backend.start()
    await broker.start()
  })

  afterEach(async () => {
    await backend.stop()
    await broker.stop()
  })

  function wireBackend(license: Record<string, unknown>, doc: Record<string, unknown>): void {
    backend.route('GET', '/api/license/status', (_req, res) => json(res, 200, license))
    backend.route('GET', '/api/documents/doc1', (_req, res) => json(res, 200, doc))
    backend.route('POST', '/api/license/evaluation-receipts/ack', (_req, res) =>
      json(res, 200, { status: 'ok' }),
    )
  }

  it('skips the permit entirely on the signed Pro sentinel (remaining -1)', async () => {
    wireBackend(licensePayload(-1), docPayload())
    wireBroker(broker)
    const session = makeSession(backend, broker)
    const permit = await session.metering.preparePermit('doc1')
    expect(permit).toBeNull()
    expect(broker.requestsFor('POST', '/v1/permit')).toHaveLength(0)
    expect(broker.requestsFor('POST', '/v1/finalize')).toHaveLength(0)
  })

  it('finalizes the recovery receipt and returns null for an already-processed document', async () => {
    wireBackend(
      licensePayload(2),
      docPayload({ credit_status: 'evaluation', completion_receipt: 'receipt-lost' }),
    )
    wireBroker(broker, { finalizeId: 'native-77' })
    const session = makeSession(backend, broker)
    const permit = await session.metering.preparePermit('doc1')
    expect(permit).toBeNull()
    const finalizes = broker.requestsFor('POST', '/v1/finalize')
    expect(finalizes).toHaveLength(1)
    expect(JSON.parse(finalizes[0]?.body ?? '{}')).toEqual({ receipt: 'receipt-lost' })
    const acks = backend.requestsFor('POST', '/api/license/evaluation-receipts/ack')
    expect(acks).toHaveLength(1)
    expect(JSON.parse(acks[0]?.body ?? '{}')).toEqual({ native_reservation_id: 'native-77' })
    expect(broker.requestsFor('POST', '/v1/permit')).toHaveLength(0)
  })

  it.each(['evaluation', 'pro', 'sample', 'legacy'])(
    'treats credit_status %s as already processed without a receipt',
    async (creditStatus) => {
      wireBackend(licensePayload(0), docPayload({ credit_status: creditStatus }))
      wireBroker(broker)
      const session = makeSession(backend, broker)
      expect(await session.metering.preparePermit('doc1')).toBeNull()
      expect(broker.requestsFor('POST', '/v1/finalize')).toHaveLength(0)
      expect(broker.requestsFor('POST', '/v1/permit')).toHaveLength(0)
    },
  )

  it('keeps a pending reservation retryable at the cap', async () => {
    wireBackend(licensePayload(0), docPayload({ credit_status: 'evaluation_reserved' }))
    wireBroker(broker, { permit: 'permit-retry' })
    const session = makeSession(backend, broker)
    const permit = await session.metering.preparePermit('doc1')
    expect(permit).toBe('permit-retry')
  })

  it('raises the honest upsell for a genuinely new document at the cap', async () => {
    wireBackend(licensePayload(0), docPayload({ credit_status: 'unprocessed' }))
    wireBroker(broker)
    const session = makeSession(backend, broker)
    await expect(session.metering.preparePermit('doc1')).rejects.toThrow(EvaluationLimitError)
    await expect(session.metering.preparePermit('doc1')).rejects.toThrow(UPSELL_TEXT)
    expect(broker.requestsFor('POST', '/v1/permit')).toHaveLength(0)
  })

  it('fails on a missing metering commitment', async () => {
    wireBackend(licensePayload(3), docPayload({ metering_commitment: null }))
    wireBroker(broker)
    const session = makeSession(backend, broker)
    await expect(session.metering.preparePermit('doc1')).rejects.toThrow(
      'The local evaluation commitment is unavailable.',
    )
  })

  it('mints a permit through the broker with the document id and commitment', async () => {
    wireBackend(licensePayload(3), docPayload())
    wireBroker(broker, { permit: 'permit-42' })
    const session = makeSession(backend, broker)
    const permit = await session.metering.preparePermit('doc1')
    expect(permit).toBe('permit-42')
    const permits = broker.requestsFor('POST', '/v1/permit')
    expect(permits).toHaveLength(1)
    expect(JSON.parse(permits[0]?.body ?? '{}')).toEqual({
      document_id: 'doc1',
      commitment: 'commitment-1',
    })
  })

  it('maps the host limit message to the evaluation-limit upsell', async () => {
    wireBackend(licensePayload(1), docPayload())
    wireBroker(broker, {
      permitError: { status: 409, error: 'All 5 evaluation documents have been used.' },
    })
    const session = makeSession(backend, broker)
    await expect(session.metering.preparePermit('doc1')).rejects.toThrow(EvaluationLimitError)
  })

  it('passes other host errors through with enrollment guidance appended', async () => {
    wireBackend(licensePayload(1), docPayload())
    wireBroker(broker, {
      permitError: { status: 403, error: 'No active evaluation grant on this installation.' },
    })
    const session = makeSession(backend, broker)
    const failure = await session.metering.preparePermit('doc1').catch((e: Error) => e)
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toContain(
      'No active evaluation grant on this installation.',
    )
    expect((failure as Error).message).toContain(ENROLLMENT_GUIDANCE)
  })

  it('finalizeReceipt is a no-op without a receipt', async () => {
    wireBroker(broker)
    const session = makeSession(backend, broker)
    await session.metering.finalizeReceipt(null)
    await session.metering.finalizeReceipt(undefined)
    expect(broker.requestsFor('POST', '/v1/finalize')).toHaveLength(0)
  })

  it('finalizeReceipt swallows broker failures (signed journal replays later)', async () => {
    wireBroker(broker, { finalizeError: { status: 500, error: 'meter busy' } })
    const session = makeSession(backend, broker)
    await expect(session.metering.finalizeReceipt('receipt-9')).resolves.toBeUndefined()
  })

  it('finalizeReceipt swallows a failing backend ack after a durable finalize', async () => {
    wireBroker(broker, { finalizeId: 'native-5' })
    backend.route('POST', '/api/license/evaluation-receipts/ack', (_req, res) =>
      json(res, 500, { error_code: 'INTERNAL_ERROR', detail: 'boom' }),
    )
    const session = makeSession(backend, broker)
    await expect(session.metering.finalizeReceipt('receipt-9')).resolves.toBeUndefined()
    expect(broker.requestsFor('POST', '/v1/finalize')).toHaveLength(1)
    expect(backend.requestsFor('POST', '/api/license/evaluation-receipts/ack')).toHaveLength(1)
  })
})
