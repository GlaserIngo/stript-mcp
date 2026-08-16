/** The restore card, attached to stript_restore and stript_restore_file.
 *
 * The restored content never reaches this card by construction: the tool
 * results carry counts, safe placeholder tokens, and the output location
 * only. */

import { parseRestoreText } from '../src/cardText.js'
import {
  CARD_EXACT_RESTORE_LINE,
  CARD_RESTORED_CLIPBOARD_LINE,
  CARD_RESTORED_FILE_LABEL,
  CARD_RESTORED_HEADLINE,
  CARD_UNMATCHED_LABEL,
} from '../src/uiCopy.js'
import { startCard } from './bootstrap.js'
import {
  asNumber,
  asString,
  asStringArray,
  cardRoot,
  chip,
  chipRow,
  el,
  headline,
  note,
  notesDetails,
  subline,
} from './dom.js'

function render(s: Record<string, unknown>): void {
  const root = cardRoot()
  root.append(headline(CARD_RESTORED_HEADLINE))

  const replacements = asNumber(s.replacements_made) ?? 0
  root.append(
    subline(
      replacements === 1 ? '1 placeholder restored' : `${replacements} placeholders restored`,
    ),
  )

  const destination = asString(s.destination)
  const path = asString(s.path)
  if (destination === 'clipboard') {
    root.append(note(CARD_RESTORED_CLIPBOARD_LINE, 'accent'))
  } else if (path !== undefined) {
    const line = note(`${CARD_RESTORED_FILE_LABEL} `, 'accent')
    const format = asString(s.format)
    line.append(el('span', 'path', path))
    if (format !== undefined) line.append(` (${format})`)
    root.append(line)
  }

  if (s.exact_restore === true) root.append(note(CARD_EXACT_RESTORE_LINE))

  // Unmatched placeholders are [TYPE_N] tokens, safe to show.
  const unmatched = asStringArray(s.unmatched_placeholders)
  if (unmatched.length > 0) {
    root.append(note(`${CARD_UNMATCHED_LABEL}:`, 'advisory'))
    root.append(chipRow(unmatched.map((token) => chip(token))))
  }

  const block = notesDetails(asStringArray(s.warnings))
  if (block !== null) root.append(block)
}

startCard('stript-restore-card', render, parseRestoreText)
