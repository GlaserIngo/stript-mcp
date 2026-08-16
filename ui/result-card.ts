/** The anonymize result card, attached to stript_anonymize_file,
 * stript_anonymize_clipboard, and stript_fetch_result.
 *
 * Renders from structuredContent, the _meta mirror, or the parsed tool
 * text (hosts that forward only content). The anonymized text is shown in
 * a capped scrollable block (user decision 2026-07-21), it is anonymized
 * by definition and already part of the chat context. */

import { parseResultText } from '../src/cardText.js'
import {
  CARD_ANONYMIZED_HEADLINE,
  CARD_DELETED_HEADLINE,
  CARD_DELETED_LINE,
  CARD_DETECTING_LINE,
  CARD_ERROR_LINE,
  CARD_IN_REVIEW_LINE,
  CARD_NO_DETECTIONS_HEADLINE,
  CARD_NO_DETECTIONS_LINE,
  CARD_NO_REPLACEMENTS_HEADLINE,
  CARD_NO_REPLACEMENTS_LINE,
  CARD_OUTPUT_FILE_LABEL,
  CARD_PENDING_REVIEW_HEADLINE,
  CARD_PENDING_REVIEW_LINE,
  CARD_RESIDUAL_RISK_PREFIX,
  REDUCED_ACCURACY_NOTE,
} from '../src/uiCopy.js'
import { startCard } from './bootstrap.js'
import {
  asNumber,
  asRecord,
  asString,
  asStringArray,
  cardRoot,
  chip,
  chipRow,
  el,
  evaluationMeter,
  headline,
  note,
  notesDetails,
  subline,
} from './dom.js'

/** Meter, advisory, degraded note, and collapsed warnings. Shared by every
 * state that carries them. */
function appendCommon(root: HTMLElement, s: Record<string, unknown>): void {
  const evaluation = asRecord(s.evaluation)
  const remaining = evaluation === undefined ? undefined : asNumber(evaluation.remaining)
  if (remaining !== undefined) root.append(evaluationMeter(remaining))

  const risk = asRecord(s.residual_risk)
  if (risk !== undefined && risk.flagged === true) {
    const categories = asStringArray(risk.categories)
    const suffix = categories.length > 0 ? ` (${categories.join(', ')})` : ''
    root.append(note(`${CARD_RESIDUAL_RISK_PREFIX}${suffix}.`, 'advisory'))
  }

  if (s.reduced_accuracy === true) root.append(note(REDUCED_ACCURACY_NOTE))

  // The warnings list already carries the two notes rendered above, keep
  // the collapsed block free of duplicates.
  const warnings = asStringArray(s.warnings).filter(
    (w) => w !== REDUCED_ACCURACY_NOTE && !w.startsWith('Residual-risk advisory:'),
  )
  const block = notesDetails(warnings)
  if (block !== null) root.append(block)
}

function renderAnonymized(root: HTMLElement, s: Record<string, unknown>): void {
  root.append(headline(CARD_ANONYMIZED_HEADLINE))
  const replacements = asNumber(s.replacements) ?? 0
  const detections = asNumber(s.detections_total) ?? 0
  root.append(subline(`${replacements} replacements, ${detections} detections`))

  const types = asRecord(s.types)
  if (types !== undefined) {
    const chips = Object.entries(types).map(([piiType, count]) =>
      chip(piiType, asNumber(count) ?? 0),
    )
    if (chips.length > 0) root.append(chipRow(chips))
  }

  const outputFile = asString(s.output_file)
  if (outputFile !== undefined) {
    const line = note(`${CARD_OUTPUT_FILE_LABEL} `)
    line.append(el('span', 'path', outputFile))
    root.append(line)
  }

  const anonymizedText = asString(s.anonymized_text)
  if (anonymizedText !== undefined && anonymizedText.length > 0) {
    root.append(el('div', 'excerpt', anonymizedText))
  }

  appendCommon(root, s)
}

function render(s: Record<string, unknown>): void {
  const root = cardRoot()
  const status = asString(s.status) ?? 'unknown'
  switch (status) {
    case 'anonymized':
      renderAnonymized(root, s)
      break
    case 'no_detections':
      root.append(headline(CARD_NO_DETECTIONS_HEADLINE))
      root.append(note(CARD_NO_DETECTIONS_LINE))
      appendCommon(root, s)
      break
    case 'no_replacements':
      root.append(headline(CARD_NO_REPLACEMENTS_HEADLINE, true))
      root.append(note(CARD_NO_REPLACEMENTS_LINE))
      appendCommon(root, s)
      break
    case 'pending_review':
      root.append(headline(CARD_PENDING_REVIEW_HEADLINE, true))
      root.append(note(CARD_PENDING_REVIEW_LINE))
      break
    case 'deleted':
      root.append(headline(CARD_DELETED_HEADLINE, true))
      root.append(note(CARD_DELETED_LINE))
      break
    case 'detecting':
      root.append(headline('Stript', true))
      root.append(note(CARD_DETECTING_LINE))
      break
    case 'in_review':
      root.append(headline('Stript', true))
      root.append(note(CARD_IN_REVIEW_LINE))
      break
    case 'error':
      root.append(headline('Stript', true))
      root.append(note(CARD_ERROR_LINE))
      break
    default:
      root.append(headline('Stript', true))
      root.append(note(`Status: ${status}`))
      break
  }
}

startCard('stript-result-card', render, parseResultText)
