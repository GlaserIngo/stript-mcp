import type { BackendClient } from './backendClient.js'
import { StriptApiError } from './errors.js'
import type { AnonymizeResponse, DocumentResponse } from './types.js'

export type ReviewPollResult =
  | { status: 'anonymized'; result: AnonymizeResponse }
  | { status: 'pending_review'; reason: 'timeout' | 'app_closed' }
  | { status: 'deleted' }

export interface ReviewPollOptions {
  timeoutMs: number
  /** Poll GET /documents/{id} this often. Default 2000 ms (contract section 6). */
  pollIntervalMs?: number
  /** Emit a progress heartbeat this often. Default 5000 ms. */
  heartbeatMs?: number
  onHeartbeat?: (elapsedMs: number) => void | Promise<void>
  /** Injectable for deterministic tests. */
  sleep?: (ms: number) => Promise<void>
  /** Injectable for deterministic tests. */
  now?: () => number
  /** Liveness probe for the app/broker, checked every iteration. When it
   * reports false the poll ends early as pending_review (app_closed). In a
   * packaged install the app quitting also kills the backend, so the network
   * failure below covers it, but in dev and Docker-like setups the backend
   * outlives the app and the document would never flip while the user cannot
   * review anything. */
  isAppAlive?: () => Promise<boolean>
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Review-handoff poll loop (contract section 6).
 *
 * The user's Anonymize click in the app IS the approval signal: poll the
 * document every 2 seconds until its status is anonymized, then read the
 * free replay. Failure semantics:
 * - 404 means the document was deleted in the app, treat as a decline,
 * - ANONYMIZATION_STALE from the replay is NOT terminal (the user
 *   re-detected mid-review), keep polling,
 * - the app quitting mid-review (network failure) resolves to
 *   pending_review, resume works after relaunch via stript_fetch_result,
 * - timeout resolves to pending_review.
 */
export async function pollForReview(
  backend: BackendClient,
  documentId: string,
  options: ReviewPollOptions,
): Promise<ReviewPollResult> {
  const sleep = options.sleep ?? defaultSleep
  const now = options.now ?? Date.now
  const interval = options.pollIntervalMs ?? 2000
  const heartbeatEvery = options.heartbeatMs ?? 5000

  const start = now()
  let lastHeartbeat = start

  while (true) {
    let doc: DocumentResponse
    try {
      doc = await backend.getJson<DocumentResponse>(`/documents/${documentId}`)
    } catch (error) {
      if (error instanceof StriptApiError) {
        if (error.status === 404) return { status: 'deleted' }
        throw error
      }
      // Network-level failure: the app quit mid-review. The document is
      // saved, the user can finish after a relaunch.
      return { status: 'pending_review', reason: 'app_closed' }
    }

    if (doc.status === 'anonymized') {
      try {
        const result = await backend.getJson<AnonymizeResponse>(
          `/documents/${documentId}/anonymized`,
        )
        return { status: 'anonymized', result }
      } catch (error) {
        if (
          error instanceof StriptApiError &&
          error.errorCode === 'ANONYMIZATION_STALE'
        ) {
          // Re-detect during review, not terminal. Keep polling.
        } else if (error instanceof StriptApiError) {
          throw error
        } else {
          return { status: 'pending_review', reason: 'app_closed' }
        }
      }
    }

    if (options.isAppAlive && !(await options.isAppAlive())) {
      return { status: 'pending_review', reason: 'app_closed' }
    }

    if (now() - start >= options.timeoutMs) {
      return { status: 'pending_review', reason: 'timeout' }
    }

    if (options.onHeartbeat && now() - lastHeartbeat >= heartbeatEvery) {
      lastHeartbeat = now()
      await options.onHeartbeat(now() - start)
    }

    await sleep(interval)
  }
}
