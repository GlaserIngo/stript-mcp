/** Widget bootstrap: connect to the host over the MCP Apps postMessage
 * protocol and hand every pushed tool result to the card's render
 * function.
 *
 * Display-only v1: the card never calls tools, never opens links, and
 * renders only what the tool result already carries. Payload sources, in
 * order: `structuredContent` (spec), the `_meta` mirror, the card's text
 * parser (Claude Desktop as of 2026-07-21 forwards only `content` and
 * strips BOTH of the former, see src/cardText.ts), then the plain-text
 * fallback. */

import { App } from '@modelcontextprotocol/ext-apps'

import { asRecord, cardRoot, headline, note } from './dom.js'

const CARD_META_KEY = 'io.stript/card'

interface ToolResultLike {
  content?: Array<{ type?: string; text?: string }>
  structuredContent?: unknown
  _meta?: Record<string, unknown>
  isError?: boolean
}

function structuredPayload(result: ToolResultLike): Record<string, unknown> | undefined {
  const spec = asRecord(result.structuredContent)
  if (spec !== undefined) return spec
  return asRecord(result._meta?.[CARD_META_KEY])
}

function textOf(result: ToolResultLike): string | undefined {
  const entry = result.content?.find((c) => c.type === 'text' && typeof c.text === 'string')
  return entry?.text
}

function renderFallback(result: ToolResultLike): void {
  const root = cardRoot()
  root.append(headline('Stript', true))
  const text = result.content?.find((c) => c.type === 'text' && typeof c.text === 'string')
  root.append(note(text?.text ?? 'The tool call returned no displayable result.'))
}

/** Follow the HOST's theme (Claude's light/dark), not the OS's. The CSS
 * data-theme override outranks the prefers-color-scheme fallback. */
function applyTheme(theme: unknown): void {
  if (theme === 'light' || theme === 'dark') {
    document.documentElement.dataset.theme = theme
  }
}

export function startCard(
  name: string,
  render: (structured: Record<string, unknown>) => void,
  parseText?: (text: string) => Record<string, unknown> | undefined,
): void {
  const app = new App({ name, version: '0.1.0' })
  app.addEventListener('toolresult', (result) => {
    try {
      const toolResult = result as ToolResultLike
      let structured = structuredPayload(toolResult)
      if (structured === undefined && parseText !== undefined && toolResult.isError !== true) {
        const text = textOf(toolResult)
        if (text !== undefined) {
          try {
            structured = parseText(text)
          } catch {
            structured = undefined
          }
        }
      }
      if (structured !== undefined) {
        render(structured)
      } else {
        renderFallback(toolResult)
      }
    } catch {
      // Rendering must never break the host page. The card keeps its
      // previous state.
    }
  })
  app.addEventListener('hostcontextchanged', (params) => {
    try {
      applyTheme(asRecord(params)?.theme)
    } catch {
      // Theme is cosmetic, never fatal.
    }
  })
  void app
    .connect()
    .then(() => {
      try {
        const context = app.getHostContext?.()
        applyTheme(asRecord(context)?.theme)
      } catch {
        // Theme is cosmetic, never fatal.
      }
    })
    .catch(() => {
      // A failed connect leaves the empty card shell; the host shows the
      // text result regardless.
    })
}
