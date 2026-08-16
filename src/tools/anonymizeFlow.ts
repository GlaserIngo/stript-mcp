import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

import type { BridgeConfig } from '../config.js'
import { runDetection } from '../detect.js'
import { pollForReview } from '../reviewPoll.js'
import type { AnonymizeResponse, DocumentResponse, SettingsResponse } from '../types.js'
import {
  buildAnonymizeResult,
  buildNoDetectionsResult,
  extractionWarningMessages,
  fetchDetectionsCount,
  textResult,
  type BridgeSession,
  type ToolContext,
} from './shared.js'

export type AnonymizeMode = 'auto' | 'review'

export const PENDING_REVIEW_GUIDANCE =
  'The document is open in Stript and waiting for the review to finish. ' +
  'Ask the user to review the detections and click Anonymize in Stript. ' +
  'Then call stript_fetch_result again immediately: it waits for the ' +
  'review to finish and returns the result when the user is done. Repeat ' +
  'the call while the result says pending_review and the user has not ' +
  'cancelled. The document_id is optional and defaults to the most recent ' +
  'document. If the document was deleted in Stript, treat that as a ' +
  'decline and stop.'

export const REVIEW_APP_CLOSED_GUIDANCE =
  'This is not an error and nothing failed. The Stript app was closed during ' +
  'the review, so the review is simply paused. The document is saved. Tell ' +
  'the user in plain words: reopen Stript, turn AI integrations back on in ' +
  'Settings if needed, finish the review, and click Anonymize. Afterwards ' +
  'call stript_fetch_result, the document_id is optional and defaults to the ' +
  'most recent document. Do not tell the user about models loading or file ' +
  'paths, those are not the cause.'

/** Exported for the card-text round-trip tests. */
export function pendingReviewResult(
  documentId: string,
  reason: 'timeout' | 'app_closed',
): CallToolResult {
  const structured: Record<string, unknown> = {
    status: 'pending_review',
    reason,
    document_id: documentId,
    next: 'stript_fetch_result',
  }
  const guidance = reason === 'app_closed' ? REVIEW_APP_CLOSED_GUIDANCE : PENDING_REVIEW_GUIDANCE
  return textResult(`Status: pending_review for document ${documentId}. ${guidance}`, structured)
}

/** AUTO mode: permit, detect over SSE, anonymize with the user's saved app
 * settings, residual-risk advisory. App-identical semantics end to end. */
export async function runAutoFlow(
  ctx: ToolContext,
  session: BridgeSession,
  doc: DocumentResponse,
  sourceName: string,
  onProgress: (message: string) => Promise<void>,
): Promise<CallToolResult> {
  const warnings = extractionWarningMessages(doc)

  await onProgress(`Preparing ${sourceName} for detection`)
  const permit = await session.metering.preparePermit(doc.id)

  const outcome = await runDetection(
    session.backend,
    session.metering,
    doc.id,
    permit,
    async (progress) => {
      await onProgress(progress.message)
    },
  )
  warnings.push(...outcome.warnings)

  if (outcome.totalDetections === 0) {
    return buildNoDetectionsResult(
      ctx.config,
      session,
      doc.id,
      warnings,
      sourceName,
      outcome.stageWarnings,
    )
  }

  // Anonymize with the user's saved app defaults, exactly what an in-app
  // run with untouched settings would use. The backend stores the
  // threshold as a string.
  const settings = await session.backend.getJson<SettingsResponse>('/settings')
  const threshold = Number.parseFloat(settings.default_threshold)
  await onProgress('Anonymizing the document')
  const response = await session.backend.postJson<AnonymizeResponse>(
    `/documents/${doc.id}/anonymize`,
    {
      enabled_types: settings.default_pii_types,
      confidence_threshold: Number.isFinite(threshold) ? threshold : 0.5,
    },
    permit !== null ? { 'X-Stript-Evaluation-Permit': permit } : undefined,
  )
  await session.metering.finalizeReceipt(response.completion_receipt)

  return buildAnonymizeResult(
    ctx.config,
    session,
    doc.id,
    response,
    outcome.totalDetections,
    warnings,
    sourceName,
    outcome.stageWarnings,
  )
}

/** REVIEW mode: hand the document to the app (broker open-document), then
 * poll until the user's Anonymize click flips the status. The bridge mints
 * nothing in review mode, the app runs detection through its own permit
 * path (contract section 6). */
export async function runReviewFlow(
  ctx: ToolContext,
  session: BridgeSession,
  doc: DocumentResponse,
  sourceName: string,
  onProgress: (message: string) => Promise<void>,
): Promise<CallToolResult> {
  const warnings = extractionWarningMessages(doc)

  // Never open a doomed review: at the lifetime cap a new document can never
  // be anonymized, the app would just show the Pro upsell while the bridge
  // polls in silence. Surface the honest upsell in the chat instead.
  await session.metering.assertNewDocumentAllowed()

  await session.broker.openDocument(doc.id)
  await onProgress(`Opened ${sourceName} in Stript for review`)

  const timing = ctx.timing ?? {}
  const poll = await pollForReview(session.backend, doc.id, {
    timeoutMs: ctx.config.reviewTimeoutSeconds * 1000,
    ...(timing.pollIntervalMs !== undefined ? { pollIntervalMs: timing.pollIntervalMs } : {}),
    ...(timing.heartbeatMs !== undefined ? { heartbeatMs: timing.heartbeatMs } : {}),
    ...(timing.sleep !== undefined ? { sleep: timing.sleep } : {}),
    ...(timing.now !== undefined ? { now: timing.now } : {}),
    onHeartbeat: async (elapsedMs) => {
      const seconds = Math.round(elapsedMs / 1000)
      await onProgress(`Waiting for the review of ${sourceName} in Stript (${seconds}s)`)
    },
    // The broker answering proves the app is alive and integrations are on.
    // Without this, a backend that outlives the app (dev, Docker) would keep
    // the poll spinning on a document nobody can review.
    isAppAlive: async () => {
      try {
        await session.broker.info()
        return true
      } catch {
        return false
      }
    },
  })

  if (poll.status === 'deleted') {
    return textResult(
      `The document ${sourceName} was deleted in Stript before the review finished. ` +
        'Treat this as the user declining, do not retry automatically.',
      { status: 'deleted', document_id: doc.id },
    )
  }
  if (poll.status === 'pending_review') {
    return pendingReviewResult(doc.id, poll.reason)
  }

  // Known limitation: in review mode the APP runs detection, so the bridge
  // never sees the SSE stream and the backend does not persist degraded-run
  // (stage_warning) state after the fact. A reduced-accuracy note cannot be
  // attached here, but the user saw the app's own reduced-accuracy banner
  // during the review. Documented in docs/INTEGRATIONS_MCP.md section 6.
  const detectionsTotal = await fetchDetectionsCount(session.backend, doc.id)
  return buildAnonymizeResult(
    ctx.config,
    session,
    doc.id,
    poll.result,
    detectionsTotal,
    warnings,
    sourceName,
  )
}

export async function runAnonymizeFlow(
  ctx: ToolContext,
  session: BridgeSession,
  doc: DocumentResponse,
  mode: AnonymizeMode,
  sourceName: string,
  onProgress: (message: string) => Promise<void>,
): Promise<CallToolResult> {
  if (mode === 'review') {
    return runReviewFlow(ctx, session, doc, sourceName, onProgress)
  }
  return runAutoFlow(ctx, session, doc, sourceName, onProgress)
}
