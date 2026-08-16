/** MCP Apps card resources (spec extension 2026-01-26).
 *
 * Each tool links its card via _meta.ui.resourceUri, and the ui:// HTML
 * resources registered here serve the fully self-contained card pages
 * (inline CSS and JS, no external requests, built by scripts/build-ui.mjs).
 * Hosts without MCP Apps support ignore the metadata and show the normal
 * text and structured result, degradation is automatic.
 *
 * Display-only v1: cards render what the tool result already carries.
 * No new data channels, no widget-initiated tool calls, no PII, and never
 * the anonymized text itself (it is already in the chat). */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { registerAppResource, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server'

import { RESTORE_CARD_HTML, RESULT_CARD_HTML, STATUS_CARD_HTML } from './ui/generated.js'

export const RESULT_CARD_URI = 'ui://stript/result-card.html'
export const STATUS_CARD_URI = 'ui://stript/status-card.html'
export const RESTORE_CARD_URI = 'ui://stript/restore-card.html'

/** The _meta block a card-bearing tool passes to registerAppTool. */
export function uiMeta(resourceUri: string): { ui: { resourceUri: string } } {
  return { ui: { resourceUri } }
}

export function registerUiResources(server: McpServer): void {
  const cards: Array<[string, string, string, string]> = [
    ['Stript result card', RESULT_CARD_URI, RESULT_CARD_HTML, 'Anonymization result summary'],
    ['Stript status card', STATUS_CARD_URI, STATUS_CARD_HTML, 'App status summary'],
    ['Stript restore card', RESTORE_CARD_URI, RESTORE_CARD_HTML, 'Restore result summary'],
  ]
  for (const [name, uri, html, description] of cards) {
    registerAppResource(server, name, uri, { description }, async () => ({
      contents: [{ uri, mimeType: RESOURCE_MIME_TYPE, text: html }],
    }))
  }
}
