import { describe, expect, it } from 'vitest'

import { NO_FILE_GUIDANCE, UNREACHABLE_GUIDANCE, versionMismatchGuidance } from '../src/discovery.js'
import {
  ENROLLMENT_GUIDANCE,
  KEY_RECOVERY_TEXT,
  STALE_TEXT,
  UPSELL_TEXT,
} from '../src/errors.js'
import { buildServer, SERVER_INSTRUCTIONS } from '../src/server.js'
import { ANONYMIZE_CLIPBOARD_DESCRIPTION } from '../src/tools/anonymizeClipboard.js'
import { ANONYMIZE_FILE_DESCRIPTION } from '../src/tools/anonymizeFile.js'
import { PENDING_REVIEW_GUIDANCE } from '../src/tools/anonymizeFlow.js'
import { FETCH_RESULT_DESCRIPTION } from '../src/tools/fetchResult.js'
import { RESTORE_DESCRIPTION } from '../src/tools/restore.js'
import { RESTORE_FILE_DESCRIPTION } from '../src/tools/restoreFile.js'
import { STATUS_DESCRIPTION } from '../src/tools/status.js'
import { testConfig } from './helpers.js'

interface ToolAnnotationsShape {
  title?: string
  readOnlyHint?: boolean
  destructiveHint?: boolean
  openWorldHint?: boolean
}

function registeredTools(server: unknown): Record<string, { annotations?: ToolAnnotationsShape }> {
  return (server as { _registeredTools: Record<string, { annotations?: ToolAnnotationsShape }> })
    ._registeredTools
}

function registeredToolNames(server: unknown): string[] {
  return Object.keys(registeredTools(server))
}

describe('buildServer', () => {
  it('registers the clipboard tool only when enabled in config', () => {
    const withoutClipboard = buildServer(testConfig({ enableClipboard: false }))
    expect(registeredToolNames(withoutClipboard)).toEqual([
      'stript_anonymize_file',
      'stript_fetch_result',
      'stript_restore',
      'stript_restore_file',
      'stript_status',
    ])

    const withClipboard = buildServer(testConfig({ enableClipboard: true }))
    expect(registeredToolNames(withClipboard)).toContain('stript_anonymize_clipboard')
  })
})

describe('tool annotations (Anthropic directory prerequisite)', () => {
  // Every tool must carry a human title plus honest read-only/destructive
  // hints. The read-only pair only inspects state; the others create new
  // documents or output files and never overwrite anything.
  const expectedHints: Record<string, boolean> = {
    stript_status: true,
    stript_fetch_result: true,
    stript_anonymize_file: false,
    stript_anonymize_clipboard: false,
    stript_restore: false,
    stript_restore_file: false,
  }

  const server = buildServer(testConfig({ enableClipboard: true }))
  const tools = registeredTools(server)

  it('covers every registered tool', () => {
    expect(Object.keys(tools).sort()).toEqual(Object.keys(expectedHints).sort())
  })

  it.each(Object.entries(expectedHints))(
    '%s exposes a titled, honest annotation block',
    (name, readOnly) => {
      const annotations = tools[name]?.annotations
      expect(annotations).toBeDefined()
      expect(typeof annotations?.title).toBe('string')
      expect((annotations?.title ?? '').length).toBeGreaterThan(0)
      expect(annotations?.readOnlyHint).toBe(readOnly)
      // No Stript tool destroys or overwrites existing data.
      expect(annotations?.destructiveHint).toBe(false)
      // The bridge only talks to the local Stript app, never the open web.
      expect(annotations?.openWorldHint).toBe(false)
    },
  )
})

describe('house style of user-visible text', () => {
  const surfaces: Array<[string, string]> = [
    ['server instructions', SERVER_INSTRUCTIONS],
    ['anonymize_file description', ANONYMIZE_FILE_DESCRIPTION],
    ['anonymize_clipboard description', ANONYMIZE_CLIPBOARD_DESCRIPTION],
    ['fetch_result description', FETCH_RESULT_DESCRIPTION],
    ['restore description', RESTORE_DESCRIPTION],
    ['restore_file description', RESTORE_FILE_DESCRIPTION],
    ['status description', STATUS_DESCRIPTION],
    ['pending review guidance', PENDING_REVIEW_GUIDANCE],
    ['upsell', UPSELL_TEXT],
    ['enrollment guidance', ENROLLMENT_GUIDANCE],
    ['key recovery', KEY_RECOVERY_TEXT],
    ['stale', STALE_TEXT],
    ['no file guidance', NO_FILE_GUIDANCE],
    ['unreachable guidance', UNREACHABLE_GUIDANCE],
    ['version mismatch', versionMismatchGuidance(2)],
  ]

  it.each(surfaces)('%s contains no em dashes and no semicolons', (_name, text) => {
    expect(text).not.toContain('—')
    expect(text).not.toContain(';')
  })

  it('the upsell carries the exact honest copy', () => {
    expect(UPSELL_TEXT).toBe(
      'This installation has used its 5 evaluation documents. Stript Pro ' +
        'unlocks unlimited new documents. Existing documents and all of their ' +
        'exports remain available. Get Stript Pro at https://stript.io',
    )
  })
})
