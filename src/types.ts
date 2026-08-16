/** Backend wire shapes, verified against the FastAPI code on this branch.
 *
 * Only the fields the bridge consumes are declared. Fields that carry raw
 * document content or original PII (document text, mapping originals,
 * restored text) are declared where the endpoint returns them, but the
 * bridge never copies them into a tool result.
 */

export interface ExtractionWarning {
  code: string
  message: string
  params?: Record<string, string> | null
}

export interface DocumentResponse {
  id: string
  filename: string | null
  mime_type: string
  status: string
  char_count: number
  page_count?: number | null
  created_at: string
  /** Raw document text. NEVER copied into a tool result. */
  text?: string | null
  extraction_method?: string | null
  warnings?: ExtractionWarning[]
  billed?: boolean
  credit_status?: string
  metering_commitment?: string | null
  completion_receipt?: string | null
}

export interface UsageInfo {
  documents_processed: number
  limit: number
  remaining: number
  scope: string
}

export interface LicenseStatusResponse {
  tier: string
  license_key_present: boolean
  valid: boolean
  expires_at: string | null
  last_validated: string | null
  grace_period_active: boolean
  usage: UsageInfo
}

export interface SettingsResponse {
  /** Stored as a string by the backend settings KV, for example "0.5". */
  default_threshold: string
  default_pii_types: string[]
}

export interface MappingEntry {
  placeholder: string
  /** Original PII surface. NEVER copied into a tool result. */
  original_text: string
  pii_type: string
  occurrences: number
}

export interface AnonymizationStats {
  total_replacements: number
  unique_entities: number
  pii_types_found: string[]
}

export interface AnonymizeResponse {
  document_id: string
  project_id: string
  anonymized_text: string
  mapping: MappingEntry[]
  clusters: unknown[]
  stats: AnonymizationStats
  completion_receipt?: string | null
}

export interface ResidualRiskResponse {
  flagged: boolean
  categories: string[]
}

export interface DeanonymizeResponse {
  /** Restored PII text. NEVER copied into a tool result. */
  restored_text: string
  replacements_made: number
  unmatched_placeholders: string[]
  ambiguous_skipped: string[]
  exact_restore: boolean
}

export interface DeanonymizeFileDownload {
  filename: string
  format: string
  mime_type: string
  file_base64: string
}

export interface DeanonymizeFileResponse {
  /** Extracted input text. NEVER copied into a tool result. */
  input_text: string
  /** Restored PII text. NEVER copied into a tool result. */
  restored_text: string
  replacements_made: number
  unmatched_placeholders: string[]
  ambiguous_skipped: string[]
  warnings: Array<{ code: string; message: string }>
  download: DeanonymizeFileDownload | null
  exact_restore: boolean
}

export interface HealthResponse {
  status: string
  version: string
  compute_profile?: string
  models_loaded?: Record<string, boolean>
}

export interface BrokerInfoResponse {
  protocol: number
  app_version: string
}
