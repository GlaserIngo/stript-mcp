import { describe, expect, it } from 'vitest'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'

import { buildServer } from '../src/server.js'
import { REDUCED_ACCURACY_NOTE } from '../src/tools/shared.js'
import { RESTORE_CARD_URI, RESULT_CARD_URI, STATUS_CARD_URI } from '../src/ui.js'
import { RESTORE_CARD_HTML, RESULT_CARD_HTML, STATUS_CARD_HTML } from '../src/ui/generated.js'
import * as uiCopy from '../src/uiCopy.js'
import { testConfig } from './helpers.js'

const CARD_MIME = 'text/html;profile=mcp-app'

const CARDS: Array<[string, string, string]> = [
  ['result', RESULT_CARD_URI, RESULT_CARD_HTML],
  ['status', STATUS_CARD_URI, STATUS_CARD_HTML],
  ['restore', RESTORE_CARD_URI, RESTORE_CARD_HTML],
]

async function connectedClient(): Promise<Client> {
  const server = buildServer(testConfig({ enableClipboard: true }))
  const client = new Client({ name: 'ui-test-client', version: '0.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)])
  return client
}

describe('tool card metadata', () => {
  const expected: Record<string, string> = {
    stript_anonymize_file: RESULT_CARD_URI,
    stript_anonymize_clipboard: RESULT_CARD_URI,
    stript_fetch_result: RESULT_CARD_URI,
    stript_restore: RESTORE_CARD_URI,
    stript_restore_file: RESTORE_CARD_URI,
    stript_status: STATUS_CARD_URI,
  }

  it('every tool carries its card resourceUri in _meta', async () => {
    const client = await connectedClient()
    const { tools } = await client.listTools()
    const byName = new Map(tools.map((tool) => [tool.name, tool]))
    for (const [name, uri] of Object.entries(expected)) {
      const tool = byName.get(name)
      expect(tool, name).toBeDefined()
      const meta = tool?._meta as Record<string, unknown> | undefined
      expect((meta?.ui as { resourceUri?: string } | undefined)?.resourceUri, name).toBe(uri)
      // registerAppTool also writes the legacy key for older hosts.
      expect(meta?.['ui/resourceUri'], name).toBe(uri)
    }
    await client.close()
  })
})

describe('ui:// card resources', () => {
  it('are listed and served with the MCP Apps mime type and the built HTML', async () => {
    const client = await connectedClient()
    const { resources } = await client.listResources()
    const uris = resources.map((r) => r.uri)
    for (const [name, uri, html] of CARDS) {
      expect(uris, name).toContain(uri)
      const read = await client.readResource({ uri })
      expect(read.contents).toHaveLength(1)
      const content = read.contents[0] as { mimeType?: string; text?: string } | undefined
      expect(content?.mimeType, name).toBe(CARD_MIME)
      expect(content?.text, name).toBe(html)
    }
    await client.close()
  })
})

describe('card self-containment (sandboxed iframe, deny-by-default CSP)', () => {
  // Markup checks run with the inline script body removed. The bundled
  // widget runtime contains inert scheme strings (json-schema ids, zod
  // validator names), so the script is checked for network primitives
  // instead of string content.
  function markupOf(html: string): string {
    const markup = html.replace(/<script>[\s\S]*<\/script>/, '<script></script>')
    expect(markup).not.toBe(html)
    return markup
  }

  it.each(CARDS)('%s card markup references nothing external', (_name, _uri, html) => {
    const markup = markupOf(html)
    expect(markup).not.toMatch(/\bsrc\s*=/i)
    expect(markup).not.toMatch(/\bhref\s*=/i)
    expect(markup).not.toMatch(/<link\b/i)
    expect(markup).not.toContain('@import')
    expect(markup).not.toMatch(/\burl\s*\(/i)
    expect(markup).not.toContain('http://')
    expect(markup).not.toContain('https://')
  })

  it.each(CARDS)('%s card script uses no network primitives', (_name, _uri, html) => {
    expect(html).not.toContain('fetch(')
    expect(html).not.toContain('XMLHttpRequest')
    expect(html).not.toContain('new WebSocket')
    expect(html).not.toContain('EventSource')
    expect(html).not.toContain('sendBeacon')
    expect(html).not.toContain('import(')
  })

  it.each(CARDS)('%s card inlines exactly one style and one script block', (_name, _uri, html) => {
    expect(html.match(/<style>/g)).toHaveLength(1)
    expect(html.match(/<script>/g)).toHaveLength(1)
  })
})

describe('card template smoke', () => {
  it.each(CARDS)('%s card has the root element and the waiting state', (_name, _uri, html) => {
    expect(html).toContain('id="stript-card"')
    expect(html).toContain('id="stript-waiting"')
    expect(html).toContain(uiCopy.CARD_WAITING_LINE)
  })

  it('the result card carries its state copy', () => {
    expect(RESULT_CARD_HTML).toContain(uiCopy.CARD_ANONYMIZED_HEADLINE)
    expect(RESULT_CARD_HTML).toContain(uiCopy.CARD_NO_DETECTIONS_HEADLINE)
    expect(RESULT_CARD_HTML).toContain(uiCopy.CARD_NO_REPLACEMENTS_HEADLINE)
    expect(RESULT_CARD_HTML).toContain(uiCopy.CARD_PENDING_REVIEW_LINE)
    expect(RESULT_CARD_HTML).toContain(uiCopy.CARD_DELETED_HEADLINE)
    expect(RESULT_CARD_HTML).toContain(uiCopy.CARD_UPSELL_LINE)
    expect(RESULT_CARD_HTML).toContain(uiCopy.CARD_RESIDUAL_RISK_PREFIX)
    expect(RESULT_CARD_HTML).toContain(REDUCED_ACCURACY_NOTE)
  })

  it('the status card carries its state copy', () => {
    expect(STATUS_CARD_HTML).toContain(uiCopy.CARD_STATUS_RUNNING_HEADLINE)
    expect(STATUS_CARD_HTML).toContain(uiCopy.CARD_STATUS_UNAVAILABLE_HEADLINE)
    expect(STATUS_CARD_HTML).toContain(uiCopy.CARD_STATUS_MODELS_LOADING)
    expect(STATUS_CARD_HTML).toContain(uiCopy.CARD_UPSELL_LINE)
  })

  it('the restore card carries its state copy', () => {
    expect(RESTORE_CARD_HTML).toContain(uiCopy.CARD_RESTORED_HEADLINE)
    expect(RESTORE_CARD_HTML).toContain(uiCopy.CARD_RESTORED_CLIPBOARD_LINE)
    expect(RESTORE_CARD_HTML).toContain(uiCopy.CARD_EXACT_RESTORE_LINE)
    expect(RESTORE_CARD_HTML).toContain(uiCopy.CARD_UNMATCHED_LABEL)
  })

  it('the result card renders the anonymized text in the excerpt block', () => {
    // User decision 2026-07-21: the card shows the anonymized text (it is
    // anonymized by definition and already part of the chat context).
    expect(RESULT_CARD_HTML).toContain('anonymized_text')
    expect(RESULT_CARD_HTML).toContain('excerpt')
  })
})

describe('card copy house style', () => {
  const entries = Object.entries(uiCopy).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string',
  )

  it.each(entries)('%s contains no em dashes and no semicolons', (_name, text) => {
    expect(text).not.toContain('—')
    expect(text).not.toContain(';')
  })

  it('the degraded note wording is unchanged by the uiCopy move', () => {
    expect(REDUCED_ACCURACY_NOTE).toBe(
      'Note: detection ran with reduced accuracy on this document (a detection ' +
        'model was unavailable). Review the result in Stript before relying on it.',
    )
    expect(uiCopy.REDUCED_ACCURACY_NOTE).toBe(REDUCED_ACCURACY_NOTE)
  })

  it('the card upsell line is the honest at-the-cap copy', () => {
    expect(uiCopy.CARD_UPSELL_LINE).toBe(
      'All 5 evaluation documents used. Stript Pro removes the limit - stript.io',
    )
  })
})
