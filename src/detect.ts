import type { BackendClient } from './backendClient.js'
import { BridgeError } from './errors.js'
import type { Metering } from './metering.js'

export interface DetectionProgress {
  stage: string
  message: string
}

/** One non-fatal `stage_warning` SSE event: the pipeline continued but ran
 * degraded (reduced detection accuracy). The app shows a banner for these,
 * the bridge surfaces them in the tool result. */
export interface StageWarning {
  stage: string
  reason: string
  message: string
}

export interface DetectionOutcome {
  totalDetections: number
  durationMs: number
  /** User-facing warning messages (backend strings, already sanitized). */
  warnings: string[]
  /** The structured degraded-run events behind those messages. */
  stageWarnings: StageWarning[]
}

/** Consume the detect SSE stream with app-identical semantics
 * (frontend/src/hooks/useDetectionStream.ts):
 *
 * - completion receipts are finalized on BOTH terminal events, complete
 *   and error (a signed evaluation outcome must reach the native meter
 *   either way),
 * - an error event is a failure carrying the backend's message,
 * - a stream that ends without a terminal event is a failure, never a
 *   partial run presented as complete.
 */
export async function runDetection(
  backend: BackendClient,
  metering: Metering,
  documentId: string,
  permit: string | null,
  onProgress?: (progress: DetectionProgress) => void | Promise<void>,
): Promise<DetectionOutcome> {
  let terminal: 'complete' | 'error' | null = null
  let totalDetections = 0
  let durationMs = 0
  let errorMessage = 'Detection failed.'
  const warnings: string[] = []
  const stageWarnings: StageWarning[] = []

  for await (const evt of backend.detectStream(documentId, permit)) {
    let payload: Record<string, unknown>
    try {
      payload = JSON.parse(evt.data) as Record<string, unknown>
    } catch {
      continue
    }

    switch (evt.event) {
      case 'queue_wait':
      case 'stage_start':
      case 'stage_complete':
      case 'stage_progress': {
        const message = typeof payload.message === 'string' ? payload.message : ''
        if (onProgress && message.length > 0) {
          await onProgress({
            stage: typeof payload.stage === 'string' ? payload.stage : 'detection',
            message,
          })
        }
        break
      }
      case 'stage_warning': {
        const message = typeof payload.message === 'string' ? payload.message : ''
        const reason = typeof payload.reason === 'string' ? payload.reason : ''
        if (message.length > 0 || reason.length > 0) {
          stageWarnings.push({
            stage: typeof payload.stage === 'string' ? payload.stage : '',
            reason,
            message,
          })
          if (message.length > 0) warnings.push(message)
        }
        break
      }
      case 'complete': {
        await metering.finalizeReceipt(
          typeof payload.completion_receipt === 'string' ? payload.completion_receipt : undefined,
        )
        totalDetections =
          typeof payload.total_detections === 'number' ? payload.total_detections : 0
        durationMs = typeof payload.duration_ms === 'number' ? payload.duration_ms : 0
        terminal = 'complete'
        break
      }
      case 'error': {
        await metering.finalizeReceipt(
          typeof payload.completion_receipt === 'string' ? payload.completion_receipt : undefined,
        )
        if (typeof payload.message === 'string' && payload.message.length > 0) {
          errorMessage = payload.message
        }
        terminal = 'error'
        break
      }
      default:
        break
    }
    if (terminal !== null) break
  }

  if (terminal === 'error') throw new BridgeError(errorMessage)
  if (terminal !== 'complete') {
    throw new BridgeError(
      'The detection stream ended before it finished. Stript may have quit ' +
        'or restarted mid-run. Open Stript and try again.',
    )
  }
  return { totalDetections, durationMs, warnings, stageWarnings }
}
