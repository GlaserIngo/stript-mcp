/** User-visible copy shared between tool results and the MCP Apps cards.
 *
 * Pure module by design: no imports, no node builtins, so the sandboxed
 * card widgets can bundle it without dragging server code into the iframe.
 * House style: no em dashes, no semicolons, no model names, no internal
 * stage names, calm not alarming.
 */

/** The calm degraded-run note. Single source of truth, re-exported by
 * tools/shared.ts for the text results and rendered verbatim by the
 * result card. */
export const REDUCED_ACCURACY_NOTE =
  'Note: detection ran with reduced accuracy on this document (a detection ' +
  'model was unavailable). Review the result in Stript before relying on it.'

/** The honest at-the-cap line shown on cards when 0 evaluation documents
 * remain. */
export const CARD_UPSELL_LINE =
  'All 5 evaluation documents used. Stript Pro removes the limit - stript.io'

export const CARD_EVALUATION_LABEL = 'Free Evaluation'
export const CARD_UNLIMITED_LABEL = 'Unlimited'

export const CARD_WAITING_LINE = 'Waiting for the Stript result.'

export const CARD_ANONYMIZED_HEADLINE = 'Document anonymized'
export const CARD_NO_DETECTIONS_HEADLINE = 'No personal data found'
export const CARD_NO_DETECTIONS_LINE =
  'Stript found no personal data in this document.'
export const CARD_NO_REPLACEMENTS_HEADLINE = 'No replacements made'
export const CARD_NO_REPLACEMENTS_LINE =
  'Every detection was rejected during review or nothing was eligible. ' +
  'Open the document in Stript to review it.'
export const CARD_PENDING_REVIEW_HEADLINE = 'Waiting for review in Stript'
export const CARD_PENDING_REVIEW_LINE =
  'Open in the Stript app, finish the review, then ask Claude to fetch the result.'
export const CARD_DELETED_HEADLINE = 'Document deleted in Stript'
export const CARD_DELETED_LINE = 'The user declined to share this document.'
export const CARD_DETECTING_LINE =
  'Stript is still detecting personal data in this document.'
export const CARD_IN_REVIEW_LINE = 'The document is in review in Stript.'
export const CARD_ERROR_LINE =
  'Detection did not finish for this document. Open it in Stript and run ' +
  'detection again.'

/** Advisory prefix for the quasi-identifier note. The categories list is
 * appended at render time. */
export const CARD_RESIDUAL_RISK_PREFIX =
  'Advisory: the remaining text still combines quasi identifiers'

export const CARD_OUTPUT_FILE_LABEL = 'Anonymized text written to'

export const CARD_RESTORED_HEADLINE = 'Originals restored'
export const CARD_RESTORED_CLIPBOARD_LINE = 'Restored text written to the clipboard'
export const CARD_RESTORED_FILE_LABEL = 'Restored file written to'
export const CARD_EXACT_RESTORE_LINE =
  'Every occurrence was restored to its exact original form.'
export const CARD_UNMATCHED_LABEL = 'Placeholders without a stored original'

export const CARD_STATUS_RUNNING_HEADLINE = 'Stript is running'
export const CARD_STATUS_UNAVAILABLE_HEADLINE = 'Stript is not reachable'
export const CARD_STATUS_INTEGRATIONS_LABEL = 'AI integrations'
export const CARD_STATUS_INTEGRATIONS_ON = 'Enabled'
export const CARD_STATUS_INTEGRATIONS_OFF = 'Disabled'
export const CARD_STATUS_TIER_LABEL = 'License'
export const CARD_STATUS_TIER_PRO = 'Stript Pro'
export const CARD_STATUS_TIER_FREE = 'Free Evaluation'
export const CARD_STATUS_MODELS_LABEL = 'Detection models'
export const CARD_STATUS_MODELS_READY = 'Loaded'
export const CARD_STATUS_MODELS_LOADING =
  'Still loading, the first run may take longer'
