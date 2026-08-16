import type { BackendClient } from './backendClient.js'
import type { BrokerClient } from './brokerClient.js'
import { ENROLLMENT_GUIDANCE, EvaluationLimitError } from './errors.js'
import type { DocumentResponse, LicenseStatusResponse } from './types.js'

export { EvaluationLimitError }

/** Credit states that mean the document was already processed and is free. */
const PROCESSED_CREDIT_STATUSES = ['evaluation', 'pro', 'sample', 'legacy']

/** Byte-for-byte behavioral mirror of the webview metering contract in
 * frontend/src/lib/platform.ts (prepareEvaluationPermit and
 * finalizeEvaluationReceipt), with the Tauri IPC calls replaced by the
 * integration broker HTTP surface (contract section 5). */
export class Metering {
  constructor(
    private readonly backend: BackendClient,
    private readonly broker: BrokerClient,
  ) {}

  /** Ask the native host for a one-use Free-processing permit when needed.
   *
   * Returns null when no permit is required (signed Pro entitlement, or the
   * document was already processed and re-processing is free).
   */
  async preparePermit(documentId: string): Promise<string | null> {
    // 1. Parallel license + document reads.
    let license: LicenseStatusResponse
    let document: DocumentResponse
    try {
      ;[license, document] = await Promise.all([
        this.backend.getJson<LicenseStatusResponse>('/license/status'),
        this.backend.getJson<DocumentResponse>(`/documents/${documentId}`),
      ])
    } catch {
      throw new Error('Could not verify the local evaluation state.')
    }

    // 2. The backend's -1 usage sentinel means the signed entitlement
    //    currently grants unlimited processing.
    if (license.usage?.remaining === -1) return null

    // 3. A backend transaction can commit while its terminal response is
    //    lost. Applying the signed recovery receipt is safe to repeat and
    //    clears the matching native reservation without charging twice.
    if (PROCESSED_CREDIT_STATUSES.includes(document.credit_status ?? '')) {
      await this.finalizeReceipt(document.completion_receipt)
      return null
    }

    // 4. A pending reservation must remain retryable for this same document
    //    even when all five slots are occupied. Only a genuinely new
    //    document is denied.
    if (document.credit_status !== 'evaluation_reserved' && license.usage?.remaining === 0) {
      throw new EvaluationLimitError()
    }

    // 5. The commitment is minted by the backend at ingest.
    if (!document.metering_commitment) {
      throw new Error('The local evaluation commitment is unavailable.')
    }

    // 6. Mint the permit through the broker (the exact
    //    reserve_evaluation_document path inside the signed host).
    try {
      return await this.broker.permit(documentId, document.metering_commitment)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message.includes('All 5 evaluation documents')) {
        throw new EvaluationLimitError()
      }
      // Pass the host's own error string through with added guidance. A
      // non-limit permit failure usually means the Free Evaluation is not
      // active on this installation (enrollment is host-only by design).
      throw new Error(`${message} ${ENROLLMENT_GUIDANCE}`)
    }
  }

  /** Cap pre-check for review mode. Review mode never mints a permit through
   * the bridge (the app does), so it never runs preparePermit's cap logic.
   * Without this, a review at the 5-document limit opens a document in the
   * app that can never be anonymized (the app shows the Pro upsell), and the
   * bridge just polls until timeout while the chat says nothing. Called
   * before opening the document so the honest upsell reaches the chat
   * immediately and the app is never opened on a doomed review. */
  async assertNewDocumentAllowed(): Promise<void> {
    let license: LicenseStatusResponse
    try {
      license = await this.backend.getJson<LicenseStatusResponse>('/license/status')
    } catch {
      throw new Error('Could not verify the local evaluation state.')
    }
    // -1 is the signed Pro sentinel (unlimited). 0 means the lifetime cap is
    // reached for a new document.
    if (license.usage?.remaining === 0) {
      throw new EvaluationLimitError()
    }
  }

  /** Finalize or release the matching native reservation using a backend
   * receipt. Best-effort by contract: every failure is swallowed because the
   * backend outcome already committed and its signed journal row replays on
   * a later app launch. */
  async finalizeReceipt(receipt?: string | null): Promise<void> {
    if (!receipt) return
    try {
      const nativeReservationId = await this.broker.finalize(receipt)
      // ACK only after the native credential-store state is durable.
      await this.backend
        .postJson('/license/evaluation-receipts/ack', {
          native_reservation_id: nativeReservationId,
        })
        .catch(() => undefined)
    } catch {
      // Never turn committed processing into a false failure here.
    }
  }
}
