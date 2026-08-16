import { BrokerError } from './errors.js'
import type { BrokerInfoResponse } from './types.js'

async function buildBrokerError(response: Response): Promise<BrokerError> {
  let message = `Broker request failed with status ${response.status}.`
  try {
    const body = (await response.json()) as { error?: string }
    if (typeof body.error === 'string' && body.error.length > 0) {
      // Host error strings pass through unchanged (contract section 3).
      message = body.error
    }
  } catch {
    // Non-JSON body, keep the generic message.
  }
  return new BrokerError(response.status, message)
}

/** Client for the loopback integration broker inside the signed Tauri host.
 * All requests carry the per-launch token as X-Stript-Integration-Token. */
export class BrokerClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  private async post<T>(path: string, body: unknown): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'X-Stript-Integration-Token': this.token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })
    if (!response.ok) throw await buildBrokerError(response)
    if (response.status === 204) return undefined as T
    const text = await response.text()
    if (text.length === 0) return undefined as T
    return JSON.parse(text) as T
  }

  /** Liveness and version handshake. */
  async info(): Promise<BrokerInfoResponse> {
    const response = await fetch(`${this.baseUrl}/info`, {
      headers: { 'X-Stript-Integration-Token': this.token },
    })
    if (!response.ok) throw await buildBrokerError(response)
    return (await response.json()) as BrokerInfoResponse
  }

  /** Mint an evaluation permit for a new document. */
  async permit(documentId: string, commitment: string): Promise<string> {
    const body = await this.post<{ permit: string }>('/permit', {
      document_id: documentId,
      commitment,
    })
    return body.permit
  }

  /** Apply a backend completion receipt to the native meter (idempotent). */
  async finalize(receipt: string): Promise<string> {
    const body = await this.post<{ native_reservation_id: string }>('/finalize', {
      receipt,
    })
    return body.native_reservation_id
  }

  /** Ask the host to focus or recreate the main window on a document. */
  async openDocument(documentId: string): Promise<void> {
    await this.post<void>('/open-document', { document_id: documentId })
  }
}
