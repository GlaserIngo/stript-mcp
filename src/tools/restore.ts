import { registerAppTool } from '@modelcontextprotocol/ext-apps/server'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'

import { writeClipboard } from '../clipboard.js'
import { RESTORE_CARD_URI, uiMeta } from '../ui.js'
import { CARD_EXACT_RESTORE_LINE, CARD_UNMATCHED_LABEL } from '../uiCopy.js'
import { writeOutputFile } from '../files.js'
import type { DeanonymizeResponse } from '../types.js'
import { errorResult, textResult, type ToolContext, type ToolExtra } from './shared.js'

export const RESTORE_DESCRIPTION =
  'Use this when an AI answer that contains Stript placeholders like ' +
  '[PERSON_1] or [EMAIL_2] should get the original values back. The ' +
  'restored text never appears in the chat. It is written to the user ' +
  'clipboard by default or to a local file, always tell the user where it ' +
  'went. This tool returns replacement counts only. Restoring is free, it ' +
  'never consumes an evaluation document.'

export const restoreInput = {
  text: z.string().min(1).describe('The text containing Stript placeholders to restore'),
  destination: z
    .enum(['clipboard', 'file'])
    .default('clipboard')
    .describe('Where the restored text is written, never into the chat'),
  filename: z
    .string()
    .optional()
    .describe('Output file name when destination is file'),
  project: z
    .string()
    .optional()
    .describe('Stript project id the placeholders belong to'),
}

/** The restore result surface. Deliberately has NO field that could carry
 * restored text: counts, safe placeholder tokens, and the output location
 * only. */
export interface RestoreToolResult {
  replacements_made: number
  unmatched_placeholders: string[]
  ambiguous_skipped: string[]
  exact_restore: boolean
  destination: 'clipboard' | 'file'
  path?: string
}

export const restoreOutput = {
  replacements_made: z.number(),
  unmatched_placeholders: z.array(z.string()),
  ambiguous_skipped: z.array(z.string()),
  exact_restore: z.boolean(),
  destination: z.enum(['clipboard', 'file']),
  path: z.string().optional(),
}

export function makeRestoreHandler(ctx: ToolContext) {
  return async (
    args: {
      text: string
      destination: 'clipboard' | 'file'
      filename?: string
      project?: string
    },
    _extra: ToolExtra,
  ): Promise<CallToolResult> => {
    try {
      const session = await ctx.connect()
      const response = await session.backend.postJson<DeanonymizeResponse>(
        '/anonymization/deanonymize',
        {
          text: args.text,
          project_id: args.project ?? ctx.config.defaultProject,
          allow_bracketless: false,
        },
      )

      const result: RestoreToolResult = {
        replacements_made: response.replacements_made,
        unmatched_placeholders: response.unmatched_placeholders,
        ambiguous_skipped: response.ambiguous_skipped,
        exact_restore: response.exact_restore,
        destination: args.destination,
      }

      let location: string
      if (args.destination === 'file') {
        const outputPath = await writeOutputFile(
          ctx.config.outputDir,
          args.filename ?? 'restored.txt',
          response.restored_text,
        )
        result.path = outputPath
        location = `the file ${outputPath}`
      } else {
        await writeClipboard(response.restored_text)
        location = 'the clipboard'
      }

      const lines = [
        `Restored ${result.replacements_made} placeholders. The restored text ` +
          `was written to ${location} and does not appear in this chat. Tell ` +
          'the user where it went.',
      ]
      if (result.unmatched_placeholders.length > 0) {
        lines.push(`${CARD_UNMATCHED_LABEL}: ${result.unmatched_placeholders.join(', ')}`)
      }
      if (result.exact_restore) {
        lines.push(CARD_EXACT_RESTORE_LINE)
      }
      return textResult(lines.join('\n'), result as unknown as Record<string, unknown>)
    } catch (error) {
      return errorResult(error)
    }
  }
}

export function registerRestore(server: McpServer, ctx: ToolContext): void {
  registerAppTool(
    server,
    'stript_restore',
    {
      title: 'Restore original values into placeholder text',
      description: RESTORE_DESCRIPTION,
      inputSchema: restoreInput,
      outputSchema: restoreOutput,
      annotations: {
        title: 'Restore original values into placeholder text',
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
      _meta: uiMeta(RESTORE_CARD_URI),
    },
    makeRestoreHandler(ctx),
  )
}
