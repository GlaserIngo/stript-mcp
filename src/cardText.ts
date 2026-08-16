/** Tool-result text formats shared by the result builders and the MCP Apps
 * card widgets.
 *
 * Claude Desktop (observed 2026-07-21) forwards ONLY `content` to the card
 * widget: both `structuredContent` and the result `_meta` mirror are
 * stripped before the postMessage reaches the iframe. The bridge authors
 * both sides of that wire, so the tool texts carry every fact the cards
 * render in a stable, human-readable shape, and the widgets parse those
 * texts back as the third payload source (order: structuredContent, then
 * the _meta mirror, then this parser, then the raw-text fallback).
 *
 * Builders and parsers live in ONE module on purpose: a format change that
 * touches only one side cannot compile quietly, and the round-trip tests
 * in tests/cardText.test.ts pin builder output to parser output through
 * the real result builders.
 *
 * Pure module by design: imports nothing beyond uiCopy, no node builtins,
 * no DOM, so the sandboxed card widgets bundle it without dragging server
 * code into the iframe. House style for every line: natural language, no
 * em dashes, no semicolons.
 */

import {
  CARD_EXACT_RESTORE_LINE,
  CARD_UNMATCHED_LABEL,
  REDUCED_ACCURACY_NOTE,
} from './uiCopy.js'

// ---------------------------------------------------------------------------
// Line builders (used by src/tools/*). Every line is a full sentence ending
// with a period so the texts stay natural for the model and for non-UI
// clients while remaining machine-parseable.
// ---------------------------------------------------------------------------

/** Marker line preceding the anonymized document text in the inline result.
 * The parser cuts here and never touches anything after it. */
export const ANONYMIZED_TEXT_MARKER = 'Anonymized text:'

export function anonymizedSummary(
  sourceName: string,
  replacements: number,
  detections: number,
): string {
  return `Stript anonymized ${sourceName}. ${replacements} replacements, ${detections} detections.`
}

/** Trailing guidance on the inline summary line. */
export const RESTORE_HINT =
  'Placeholders like [PERSON_1] stand in for the original values and can be ' +
  'restored later with stript_restore.'

/** Per-type breakdown, for example "Types: PERSON 2, IBAN 1." Returns
 * undefined when there is nothing to list. */
export function typesLine(types: Record<string, number>): string | undefined {
  const entries = Object.entries(types)
  if (entries.length === 0) return undefined
  return `Types: ${entries.map(([piiType, count]) => `${piiType} ${count}`).join(', ')}.`
}

export const UNLIMITED_LINE = 'Unlimited document processing (Pro).'

/** The Free Evaluation meter as a sentence. Mirrors the card meter rules:
 * -1 (and anything above the 5-document cap) reads as unlimited. */
export function evaluationLine(remaining: number): string {
  if (remaining === -1 || remaining > 5) return UNLIMITED_LINE
  return `${remaining} of 5 Free Evaluation documents remaining.`
}

export function oversizedLine(limit: number, outputPath: string): string {
  return (
    `The anonymized text is larger than ${limit} characters, so it was ` +
    `written to ${outputPath} instead of the chat.`
  )
}

export function residualRiskLine(categories: string[]): string {
  return (
    `Residual-risk advisory: the remaining text still combines quasi ` +
    `identifiers (${categories.join(', ')}). Direct identifiers were ` +
    'replaced, indirect context can still narrow down a person.'
  )
}

/** Static body sentences the parser must not misread as warnings. */
export const NO_REPLACEMENTS_BODY = [
  'Either every detection was rejected during review or nothing was eligible.',
  'Open the document in Stript to review it.',
] as const

export const NO_DETECTIONS_BODY =
  'The document text is not returned by this tool. If the user wants to ' +
  'share it anyway they can copy it themselves, or open the document in ' +
  'Stript to double-check.'

// ---------------------------------------------------------------------------
// Widget-side parsers (used by ui/*). Defensive by contract: any text the
// parser does not positively recognize yields undefined and the card falls
// back to the raw text. A parsed payload uses the exact field names the
// render functions consume, matching the structuredContent shape.
// ---------------------------------------------------------------------------

const SKIP_LINES: ReadonlySet<string> = new Set<string>([
  ...NO_REPLACEMENTS_BODY,
  NO_DETECTIONS_BODY,
])

function parseCommonLine(line: string, out: Record<string, unknown>): boolean {
  const types = /^Types: (.+)\.$/.exec(line)
  if (types !== null && types[1] !== undefined) {
    const parsed: Record<string, number> = {}
    for (const pair of types[1].split(', ')) {
      const m = /^(.+) (\d+)$/.exec(pair)
      if (m !== null && m[1] !== undefined && m[2] !== undefined) {
        parsed[m[1]] = Number(m[2])
      }
    }
    out.types = parsed
    return true
  }
  const remaining = /^(\d+) of \d+ Free Evaluation documents remaining\.$/.exec(line)
  if (remaining !== null && remaining[1] !== undefined) {
    out.evaluation = { remaining: Number(remaining[1]) }
    return true
  }
  if (line === UNLIMITED_LINE) {
    out.evaluation = { remaining: -1 }
    return true
  }
  if (line.startsWith('Residual-risk advisory:')) {
    const categories = /quasi identifiers \(([^)]*)\)/.exec(line)
    const list =
      categories?.[1] === undefined || categories[1].length === 0
        ? []
        : categories[1].split(', ')
    out.residual_risk = { flagged: true, categories: list }
    // The structured warnings list carries this note too, the card filters
    // it out of the collapsed block by prefix.
    pushWarning(out, line)
    return true
  }
  if (line === REDUCED_ACCURACY_NOTE) {
    out.reduced_accuracy = true
    pushWarning(out, line)
    return true
  }
  const output = / written to (.+) instead of the chat\.$/.exec(line)
  if (output !== null && output[1] !== undefined) {
    out.output_file = output[1]
    return true
  }
  if (SKIP_LINES.has(line)) return true
  return false
}

function pushWarning(out: Record<string, unknown>, line: string): void {
  const warnings = (out.warnings as string[] | undefined) ?? []
  warnings.push(line)
  out.warnings = warnings
}

/** Parse the anonymize result texts (anonymize_file, anonymize_clipboard,
 * fetch_result). The text after the anonymized-text marker is returned as
 * anonymized_text so the card can show it, it is anonymized by definition
 * and already part of the chat context. */
export function parseResultText(text: string): Record<string, unknown> | undefined {
  const rawLines = text.split('\n')
  const markerIndex = rawLines.indexOf(ANONYMIZED_TEXT_MARKER)
  const excerpt =
    markerIndex === -1
      ? undefined
      : rawLines
          .slice(markerIndex + 1)
          .join('\n')
          .trim()
  const head = (markerIndex === -1 ? rawLines : rawLines.slice(0, markerIndex))
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  const first = head[0]
  if (first === undefined) return undefined

  const out: Record<string, unknown> = {}
  const summary = /^Stript anonymized (.+)\. (\d+) replacements, (\d+) detections\./.exec(first)
  if (summary !== null) {
    out.status = 'anonymized'
    out.replacements = Number(summary[2])
    out.detections_total = Number(summary[3])
    if (excerpt !== undefined && excerpt.length > 0) out.anonymized_text = excerpt
  } else if (first.startsWith('Stript made no replacements')) {
    out.status = 'no_replacements'
  } else if (first.startsWith('Stript found no personal data')) {
    out.status = 'no_detections'
    out.detections_total = 0
  } else if (first.startsWith('Status: pending_review')) {
    const doc = /for document (\S+)\./.exec(first)
    if (doc?.[1] !== undefined) out.document_id = doc[1]
    return { ...out, status: 'pending_review' }
  } else if (
    first.includes('was deleted in Stript') ||
    first.includes('no longer exists in Stript')
  ) {
    return { status: 'deleted' }
  } else if (first.includes('still detecting personal data')) {
    return { status: 'detecting' }
  } else if (
    first.includes('still in review in Stript') ||
    first.includes('not been reviewed in Stript yet')
  ) {
    return { status: 'in_review' }
  } else if (first.startsWith('Detection failed for this document')) {
    return { status: 'error' }
  } else {
    return undefined
  }

  for (const line of head.slice(1)) {
    if (!parseCommonLine(line, out)) pushWarning(out, line)
  }
  return out
}

/** Parse the stript_status text. A text that does not match the running
 * pattern is guidance by construction (the status tool puts its whole
 * message into the guidance field), so this parser is total for non-empty
 * input. */
export function parseStatusText(text: string): Record<string, unknown> | undefined {
  const t = text.trim()
  if (t.length === 0) return undefined
  const running = /^Stript (\S+) is running with AI integrations enabled\./.exec(t)
  if (running === null) {
    return { app_running: false, integration_enabled: false, guidance: t }
  }
  const out: Record<string, unknown> = {
    app_running: true,
    integration_enabled: true,
    app_version: running[1],
  }
  const tier = /Tier: (\S+),/.exec(t)
  if (tier?.[1] !== undefined) out.tier = tier[1]
  const remaining = /(\d+) of \d+ Free Evaluation documents remaining/.exec(t)
  if (remaining?.[1] !== undefined) {
    out.evaluation_remaining = Number(remaining[1])
  } else if (t.includes('unlimited document processing (Pro)')) {
    out.evaluation_remaining = -1
  }
  if (t.includes('Detection models are loaded')) {
    out.models_ready = true
  } else if (t.includes('not fully loaded')) {
    out.models_ready = false
  }
  return out
}

/** Parse the restore texts (stript_restore, stript_restore_file). */
export function parseRestoreText(text: string): Record<string, unknown> | undefined {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  const first = lines[0]
  if (first === undefined) return undefined
  const head = /^Restored (\d+) placeholders/.exec(first)
  if (head === null || head[1] === undefined) return undefined

  const out: Record<string, unknown> = { replacements_made: Number(head[1]) }
  const intoFile =
    /^Restored \d+ placeholders into (.+) \(([A-Za-z0-9]+)\)\. The restored content does not appear/.exec(
      first,
    )
  const toFile = / was written to the file (.+) and does not appear/.exec(first)
  if (intoFile !== null && intoFile[1] !== undefined && intoFile[2] !== undefined) {
    out.destination = 'file'
    out.path = intoFile[1]
    out.format = intoFile[2]
  } else if (first.includes('written to the clipboard')) {
    out.destination = 'clipboard'
  } else if (toFile !== null && toFile[1] !== undefined) {
    out.destination = 'file'
    out.path = toFile[1]
  }

  const unmatchedPrefix = `${CARD_UNMATCHED_LABEL}: `
  for (const line of lines.slice(1)) {
    if (line.startsWith(unmatchedPrefix)) {
      out.unmatched_placeholders = line.slice(unmatchedPrefix.length).split(', ')
    } else if (line === CARD_EXACT_RESTORE_LINE) {
      out.exact_restore = true
    } else {
      pushWarning(out, line)
    }
  }
  return out
}
