import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js'
import type {
  CallToolResult,
  ServerNotification,
  ServerRequest,
} from '@modelcontextprotocol/sdk/types.js'

import { BackendClient } from '../backendClient.js'
import { BrokerClient } from '../brokerClient.js'
import {
  ANONYMIZED_TEXT_MARKER,
  anonymizedSummary,
  evaluationLine,
  NO_DETECTIONS_BODY,
  NO_REPLACEMENTS_BODY,
  oversizedLine,
  residualRiskLine,
  RESTORE_HINT,
  typesLine,
} from '../cardText.js'
import type { BridgeConfig } from '../config.js'
import type { StageWarning } from '../detect.js'
import type { ConnectOptions, DiscoveryInfo } from '../discovery.js'
import { connectToStript } from '../discovery.js'
import { toUserMessage } from '../errors.js'
import { writeOutputFile } from '../files.js'
import { Metering } from '../metering.js'
import { REDUCED_ACCURACY_NOTE } from '../uiCopy.js'
import type {
  AnonymizeResponse,
  DocumentResponse,
  LicenseStatusResponse,
  ResidualRiskResponse,
} from '../types.js'

export type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>

/** A live connection to the running Stript app, built per tool call. */
export interface BridgeSession {
  discovery: DiscoveryInfo
  backend: BackendClient
  broker: BrokerClient
  metering: Metering
}

/** Timing knobs, injectable so tests never wait on real clocks. */
export interface ToolTiming {
  pollIntervalMs?: number
  heartbeatMs?: number
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

export interface ToolContext {
  config: BridgeConfig
  connect: () => Promise<BridgeSession>
  timing?: ToolTiming
}

/** Production context: discovery-file lookup on every tool call. */
export function createContext(
  config: BridgeConfig,
  connectOptions: ConnectOptions = {},
): ToolContext {
  return {
    config,
    connect: async () => {
      const endpoints = await connectToStript(config, connectOptions)
      const backend = new BackendClient(endpoints.backendBaseUrl, endpoints.token)
      const broker = new BrokerClient(endpoints.brokerBaseUrl, endpoints.token)
      return {
        discovery: endpoints.discovery,
        backend,
        broker,
        metering: new Metering(backend, broker),
      }
    },
  }
}

/** Progress notifications keep client timeouts alive during long stages.
 * Sent only when the request carried a progressToken. Failures to notify
 * never fail the tool. */
export function progressReporter(extra: ToolExtra): (message: string) => Promise<void> {
  const token = extra._meta?.progressToken
  if (token === undefined) {
    return async () => {
      // The client did not ask for progress.
    }
  }
  let step = 0
  return async (message: string) => {
    step += 1
    try {
      await extra.sendNotification({
        method: 'notifications/progress',
        params: { progressToken: token, progress: step, message },
      })
    } catch {
      // Progress is best-effort.
    }
  }
}

/** The _meta key carrying a copy of the structured payload for the MCP Apps
 * card. Claude Desktop (observed 2026-07-21) forwards only `content` to the
 * widget and drops `structuredContent`, so the card reads this mirror when
 * the spec field is missing. _meta is not model-visible content. */
export const CARD_META_KEY = 'io.stript/card'

export function textResult(text: string, structured?: Record<string, unknown>): CallToolResult {
  const result: CallToolResult = { content: [{ type: 'text', text }] }
  if (structured !== undefined) {
    result.structuredContent = structured
    result._meta = { [CARD_META_KEY]: structured }
  }
  return result
}

export function errorResult(error: unknown): CallToolResult {
  return { content: [{ type: 'text', text: toUserMessage(error) }], isError: true }
}

/** The anonymize result surface shared by both anonymize tools and
 * stript_fetch_result. Safe by construction: it can carry the ANONYMIZED
 * text only, never the original document text, mapping originals, or
 * restored output. */
export interface AnonymizeToolResult {
  document_id: string
  project_id: string
  status: string
  anonymized_text?: string
  output_file?: string
  detections_total: number
  replacements: number
  types: Record<string, number>
  residual_risk?: { flagged: boolean; categories: string[] }
  evaluation: { credit_status: string; remaining: number }
  warnings: string[]
  /** True when detection ran degraded (a stage was skipped or reduced). */
  reduced_accuracy?: boolean
  /** Machine-readable reason keys from the degraded-run events. */
  degraded_reasons?: string[]
}

/** Cap above which anonymized text is written to the output directory
 * instead of being returned inline. */
export const INLINE_TEXT_LIMIT = 100_000

export async function fetchEvaluationInfo(
  backend: BackendClient,
  documentId: string,
): Promise<{ credit_status: string; remaining: number }> {
  try {
    const [license, document] = await Promise.all([
      backend.getJson<LicenseStatusResponse>('/license/status'),
      backend.getJson<DocumentResponse>(`/documents/${documentId}`),
    ])
    return {
      credit_status: document.credit_status ?? 'unknown',
      remaining: license.usage?.remaining ?? 0,
    }
  } catch {
    return { credit_status: 'unknown', remaining: 0 }
  }
}

/** Count the stored detections for a document. The rows carry the raw PII
 * surface, only the COUNT ever leaves this function. */
export async function fetchDetectionsCount(
  backend: BackendClient,
  documentId: string,
): Promise<number> {
  try {
    const rows = await backend.getJson<unknown[]>(`/documents/${documentId}/detections`)
    return Array.isArray(rows) ? rows.length : 0
  } catch {
    return 0
  }
}

export async function fetchResidualRisk(
  backend: BackendClient,
  documentId: string,
): Promise<{ flagged: boolean; categories: string[] } | undefined> {
  try {
    const risk = await backend.getJson<ResidualRiskResponse>(
      `/documents/${documentId}/residual-risk`,
    )
    return { flagged: risk.flagged, categories: risk.categories }
  } catch {
    return undefined
  }
}

function typeCounts(response: AnonymizeResponse): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const entry of response.mapping) {
    counts[entry.pii_type] = (counts[entry.pii_type] ?? 0) + (entry.occurrences || 1)
  }
  return counts
}

/** The calm degraded-run note. Product copy rules: no model names, no
 * internal stage names, not alarming. Lives in uiCopy.ts so the MCP Apps
 * result card renders the exact same wording. */
export { REDUCED_ACCURACY_NOTE } from '../uiCopy.js'

/** Fold degraded-run events into the result: the prominent note leads the
 * warnings, and the structured fields carry the reason keys. */
function applyStageWarnings(base: AnonymizeToolResult, stageWarnings: StageWarning[]): void {
  if (stageWarnings.length === 0) return
  base.reduced_accuracy = true
  const reasons = stageWarnings.map((w) => w.reason).filter((r) => r.length > 0)
  if (reasons.length > 0) base.degraded_reasons = [...new Set(reasons)]
  base.warnings.unshift(REDUCED_ACCURACY_NOTE)
}

/** Build the final anonymize result from a successful anonymize response or
 * a stored replay. Applies the zero-replacement guard and the oversized
 * text spill to the output directory. */
export async function buildAnonymizeResult(
  config: BridgeConfig,
  session: BridgeSession,
  documentId: string,
  response: AnonymizeResponse,
  detectionsTotal: number,
  warnings: string[],
  sourceName: string,
  stageWarnings: StageWarning[] = [],
): Promise<CallToolResult> {
  const evaluation = await fetchEvaluationInfo(session.backend, documentId)
  const residualRisk = await fetchResidualRisk(session.backend, documentId)

  const base: AnonymizeToolResult = {
    document_id: documentId,
    project_id: response.project_id,
    status: 'anonymized',
    detections_total: detectionsTotal,
    replacements: response.stats.total_replacements,
    types: typeCounts(response),
    evaluation,
    warnings: [...warnings],
  }
  applyStageWarnings(base, stageWarnings)
  if (residualRisk !== undefined) base.residual_risk = residualRisk
  if (residualRisk?.flagged) {
    base.warnings.push(residualRiskLine(residualRisk.categories))
  }

  // Stable fact lines the MCP Apps cards parse back out of the text on
  // hosts that forward only `content` (see src/cardText.ts).
  const factLines = (includeTypes: boolean): string[] => {
    const facts: string[] = []
    if (includeTypes) {
      const breakdown = typesLine(base.types)
      if (breakdown !== undefined) facts.push(breakdown)
    }
    if (evaluation.credit_status !== 'unknown') {
      facts.push(evaluationLine(evaluation.remaining))
    }
    return facts
  }

  // Zero-replacement guard: never return document text when nothing was
  // replaced (all detections rejected, or no eligible detections). The
  // unmodified text would be the original document.
  if (response.stats.total_replacements === 0) {
    base.status = 'no_replacements'
    const lines = [
      `Stript made no replacements in ${sourceName}, so the document text is not returned.`,
      ...NO_REPLACEMENTS_BODY,
      ...factLines(false),
      ...base.warnings,
    ]
    return textResult(lines.join('\n'), base as unknown as Record<string, unknown>)
  }

  const text = response.anonymized_text
  if (text.length > INLINE_TEXT_LIMIT) {
    const stem = sourceName.replace(/\.[^.]+$/, '')
    const outputPath = await writeOutputFile(config.outputDir, `${stem}-anonymized.txt`, text)
    base.output_file = outputPath
    const lines = [
      anonymizedSummary(sourceName, base.replacements, detectionsTotal),
      oversizedLine(INLINE_TEXT_LIMIT, outputPath),
      ...factLines(true),
      ...base.warnings,
    ]
    return textResult(lines.join('\n'), base as unknown as Record<string, unknown>)
  }

  base.anonymized_text = text
  const summary = `${anonymizedSummary(sourceName, base.replacements, detectionsTotal)} ${RESTORE_HINT}`
  const lines = [
    summary,
    ...factLines(true),
    ...base.warnings,
    '',
    ANONYMIZED_TEXT_MARKER,
    '',
    text,
  ]
  return textResult(lines.join('\n'), base as unknown as Record<string, unknown>)
}

/** Result for a detection run that found nothing. Returns counts and the
 * residual-risk advisory, never the document text. */
export async function buildNoDetectionsResult(
  config: BridgeConfig,
  session: BridgeSession,
  documentId: string,
  warnings: string[],
  sourceName: string,
  stageWarnings: StageWarning[] = [],
): Promise<CallToolResult> {
  const evaluation = await fetchEvaluationInfo(session.backend, documentId)
  const residualRisk = await fetchResidualRisk(session.backend, documentId)
  const base: AnonymizeToolResult = {
    document_id: documentId,
    project_id: config.defaultProject,
    status: 'no_detections',
    detections_total: 0,
    replacements: 0,
    types: {},
    evaluation,
    warnings: [...warnings],
  }
  applyStageWarnings(base, stageWarnings)
  if (residualRisk !== undefined) base.residual_risk = residualRisk
  const lines = [
    `Stript found no personal data in ${sourceName}.`,
    NO_DETECTIONS_BODY,
    ...(evaluation.credit_status !== 'unknown' ? [evaluationLine(evaluation.remaining)] : []),
    ...base.warnings,
  ]
  return textResult(lines.join('\n'), base as unknown as Record<string, unknown>)
}

export function extractionWarningMessages(doc: DocumentResponse): string[] {
  return (doc.warnings ?? [])
    .map((w) => w.message)
    .filter((m): m is string => typeof m === 'string' && m.length > 0)
}
