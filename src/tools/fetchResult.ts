import { registerAppTool } from '@modelcontextprotocol/ext-apps/server'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'

import { STALE_TEXT, StriptApiError } from '../errors.js'
import { pollForReview } from '../reviewPoll.js'
import { RESULT_CARD_URI, uiMeta } from '../ui.js'
import type { AnonymizeResponse, DocumentResponse } from '../types.js'
import {
  buildAnonymizeResult,
  errorResult,
  fetchDetectionsCount,
  progressReporter,
  textResult,
  type BridgeSession,
  type ToolContext,
  type ToolExtra,
} from './shared.js'
import { anonymizeOutput } from './anonymizeFile.js'
import { pendingReviewResult } from './anonymizeFlow.js'

export const FETCH_RESULT_DESCRIPTION =
  'Use this to fetch the anonymized result of a Stript document, for ' +
  'example after a pending_review status or after the app was restarted ' +
  'mid-review. If the document is still in review, this call WAITS for ' +
  'the user to finish the review in Stript and returns the result as soon ' +
  'as they click Anonymize. When it returns pending_review instead, call ' +
  'it again immediately to keep waiting, and repeat while the result says ' +
  'pending_review and the user has not cancelled. ' +
  'The document_id is optional, without it the most recent document in ' +
  'the project is fetched, so a plain "fetch my Stript result" works. ' +
  'Returns only anonymized content, never the original document text. ' +
  'Reading a stored result is free, it never consumes an evaluation ' +
  'document.'

export const NOTHING_TO_FETCH_TEXT =
  'There is no document in this Stript project yet, so there is nothing to ' +
  'fetch. Anonymize a document first.'

export const fetchResultInput = {
  document_id: z
    .string()
    .min(1)
    .optional()
    .describe('The Stript document id to fetch. Omit for the most recent document.'),
}

type ProjectDocumentsResponse = DocumentResponse[] | { documents?: DocumentResponse[] }

/** The no-argument resume path: the most recently created document in the
 * project. Users cannot see document ids, and a chat client that cut a
 * review call off never delivered one, so resume must work without it. */
async function resolveLatestDocumentId(
  session: Awaited<ReturnType<ToolContext['connect']>>,
  project: string,
): Promise<string | null> {
  const raw = await session.backend.getJson<ProjectDocumentsResponse>(
    `/projects/${project}/documents`,
  )
  const docs = Array.isArray(raw) ? raw : (raw.documents ?? [])
  if (docs.length === 0) return null
  const sorted = [...docs].sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
  return sorted[0]?.id ?? null
}

/** Chained review wait: chat clients hard-cancel long tool calls (Claude
 * Desktop at 240s) and a cancelled call delivers nothing, so no single call
 * can cover a long review. Instead every stript_fetch_result call on an
 * unfinished document WAITS up to the configured review timeout and hands
 * back the same resumable pending_review shape, so the model chains calls
 * until the user's Anonymize click lands. Same poll loop, liveness probe
 * and cap as review mode (contract section 6). */
async function awaitReview(
  ctx: ToolContext,
  session: BridgeSession,
  documentId: string,
  extra: ToolExtra,
): Promise<CallToolResult> {
  const onProgress = progressReporter(extra)
  const timing = ctx.timing ?? {}
  const poll = await pollForReview(session.backend, documentId, {
    timeoutMs: ctx.config.reviewTimeoutSeconds * 1000,
    ...(timing.pollIntervalMs !== undefined ? { pollIntervalMs: timing.pollIntervalMs } : {}),
    ...(timing.heartbeatMs !== undefined ? { heartbeatMs: timing.heartbeatMs } : {}),
    ...(timing.sleep !== undefined ? { sleep: timing.sleep } : {}),
    ...(timing.now !== undefined ? { now: timing.now } : {}),
    onHeartbeat: async (elapsedMs) => {
      const seconds = Math.round(elapsedMs / 1000)
      await onProgress(`Waiting for the review in Stript (${seconds}s)`)
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
      'The document was deleted in Stript before the review finished. ' +
        'Treat this as the user declining, do not retry automatically.',
      { status: 'deleted', document_id: documentId },
    )
  }
  if (poll.status === 'pending_review') {
    return pendingReviewResult(documentId, poll.reason)
  }

  const detectionsTotal = await fetchDetectionsCount(session.backend, documentId)
  return buildAnonymizeResult(
    ctx.config,
    session,
    documentId,
    poll.result,
    detectionsTotal,
    [],
    `document ${documentId}`,
  )
}

export function makeFetchResultHandler(ctx: ToolContext) {
  return async (args: { document_id?: string }, extra: ToolExtra): Promise<CallToolResult> => {
    try {
      const session = await ctx.connect()
      let documentId = args.document_id
      if (documentId === undefined) {
        const latest = await resolveLatestDocumentId(session, ctx.config.defaultProject)
        if (latest === null) {
          return textResult(NOTHING_TO_FETCH_TEXT, { status: 'nothing_to_fetch' })
        }
        documentId = latest
      }
      let doc: DocumentResponse
      try {
        doc = await session.backend.getJson<DocumentResponse>(`/documents/${documentId}`)
      } catch (error) {
        if (error instanceof StriptApiError && error.status === 404) {
          return textResult(
            'The document no longer exists in Stript. It was deleted, which ' +
              'usually means the user declined to share it.',
            { status: 'deleted', document_id: documentId },
          )
        }
        throw error
      }

      switch (doc.status) {
        case 'anonymized':
          break
        case 'error':
          return textResult(
            'Detection failed for this document in Stript. Ask the user to ' +
              'open it in Stript and run detection again.',
            { status: 'error', document_id: doc.id },
          )
        case 'detected': {
          const count = await fetchDetectionsCount(session.backend, doc.id)
          if (count === 0) {
            return textResult(
              'Stript found no personal data in this document. The document ' +
                'text is not returned by this tool.',
              { status: 'no_detections', document_id: doc.id, detections_total: 0 },
            )
          }
          // Still in review: wait for the user's Anonymize click instead of
          // bouncing straight back with an in_review status.
          return await awaitReview(ctx, session, doc.id, extra)
        }
        case 'detecting':
        default:
          return await awaitReview(ctx, session, doc.id, extra)
      }

      let replay: AnonymizeResponse
      try {
        replay = await session.backend.getJson<AnonymizeResponse>(
          `/documents/${doc.id}/anonymized`,
        )
      } catch (error) {
        if (error instanceof StriptApiError && error.errorCode === 'ANONYMIZATION_STALE') {
          return textResult(STALE_TEXT, { status: 'stale', document_id: doc.id })
        }
        throw error
      }

      const detectionsTotal = await fetchDetectionsCount(session.backend, doc.id)
      return await buildAnonymizeResult(
        ctx.config,
        session,
        doc.id,
        replay,
        detectionsTotal,
        [],
        `document ${doc.id}`,
      )
    } catch (error) {
      return errorResult(error)
    }
  }
}

export function registerFetchResult(server: McpServer, ctx: ToolContext): void {
  registerAppTool(
    server,
    'stript_fetch_result',
    {
      title: 'Fetch a Stript anonymization result',
      description: FETCH_RESULT_DESCRIPTION,
      inputSchema: fetchResultInput,
      outputSchema: anonymizeOutput,
      annotations: {
        title: 'Fetch a Stript anonymization result',
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
      _meta: uiMeta(RESULT_CARD_URI),
    },
    makeFetchResultHandler(ctx),
  )
}
