/** User-facing error text and error types. House style applies to every
 * string a user or model can see: no em dashes, no semicolons. */

export const UPSELL_TEXT =
  'This installation has used its 5 evaluation documents. Stript Pro unlocks ' +
  'unlimited new documents. Existing documents and all of their exports remain ' +
  'available. Get Stript Pro at https://stript.io'

export const ENROLLMENT_GUIDANCE =
  'Activate your Free Evaluation in the Stript app first (Settings).'

export const KEY_RECOVERY_TEXT = 'Open Stript to restore your encryption key.'

export const STALE_TEXT =
  'The anonymized result is out of date because detection ran again. ' +
  'Finish the review in Stript again, then fetch the result with stript_fetch_result.'

/** A bridge-level failure whose message is already user-facing. */
export class BridgeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BridgeError'
  }
}

/** Typed error for a backend `{error_code, detail}` envelope. */
export class StriptApiError extends Error {
  readonly status: number
  readonly errorCode: string
  readonly detail: string

  constructor(status: number, errorCode: string, detail: string) {
    super(detail)
    this.name = 'StriptApiError'
    this.status = status
    this.errorCode = errorCode
    this.detail = detail
  }
}

/** Broker error, message passes the host's own error string through. */
export class BrokerError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'BrokerError'
    this.status = status
  }
}

/** The honest 5-document Free Evaluation limit, surfaced in chat. */
export class EvaluationLimitError extends Error {
  constructor() {
    super(UPSELL_TEXT)
    this.name = 'EvaluationLimitError'
  }
}

/** Map a backend error to the message a user should see. */
export function userMessageForApiError(error: StriptApiError): string {
  if (error.status === 402 || error.errorCode === 'USAGE_LIMIT_EXCEEDED') {
    return UPSELL_TEXT
  }
  switch (error.errorCode) {
    case 'EVALUATION_INTEGRITY_ERROR':
      return error.detail.length > 0
        ? error.detail
        : 'Stript could not verify the evaluation records of this installation. Reinstall the signed app or contact support.'
    case 'ANONYMIZATION_STALE':
      return STALE_TEXT
    case 'KEY_RECOVERY_REQUIRED':
      return KEY_RECOVERY_TEXT
    case 'DOCUMENT_NOT_FOUND':
      return 'The document no longer exists in Stript. It may have been deleted.'
    case 'MAPPING_NOT_FOUND':
      return (
        'No anonymization mapping exists for this project yet. ' +
        'Anonymize a document in this project first, then restore.'
      )
    default:
      return error.detail.length > 0
        ? error.detail
        : `Stript returned an error (${error.errorCode}).`
  }
}

/** Convert any thrown value into user-facing text for a tool error result. */
export function toUserMessage(error: unknown): string {
  if (error instanceof StriptApiError) return userMessageForApiError(error)
  if (error instanceof Error && typeof error.message === 'string' && error.message.length > 0) {
    return error.message
  }
  return 'An unexpected error occurred inside the Stript bridge.'
}
