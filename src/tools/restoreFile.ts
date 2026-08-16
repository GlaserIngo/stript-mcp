import { readFile } from 'node:fs/promises'

import { registerAppTool } from '@modelcontextprotocol/ext-apps/server'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'

import { guardInputFile, writeOutputFile } from '../files.js'
import { RESTORE_CARD_URI, uiMeta } from '../ui.js'
import { CARD_EXACT_RESTORE_LINE, CARD_UNMATCHED_LABEL } from '../uiCopy.js'
import type { DeanonymizeFileResponse } from '../types.js'
import { errorResult, textResult, type ToolContext, type ToolExtra } from './shared.js'

export const RESTORE_FILE_DESCRIPTION =
  'Use this to restore original values into a file that contains Stript ' +
  'placeholders like [PERSON_1], keeping the file format where possible. ' +
  'Ask the user for the file path, do not ask them to paste file content ' +
  'into the chat. The restored file is written to the Stript output folder ' +
  'and its content never appears in the chat. This tool returns replacement ' +
  'counts and the output path only. Restoring is free, it never consumes an ' +
  'evaluation document.'

export const restoreFileInput = {
  path: z.string().min(1).describe('Path of the placeholder-bearing file to restore'),
  output_filename: z
    .string()
    .optional()
    .describe('Name for the restored file, defaults to a name derived from the input'),
  project: z
    .string()
    .optional()
    .describe('Stript project id the placeholders belong to'),
}

/** Counts and output location only, never file content. */
export interface RestoreFileToolResult {
  replacements_made: number
  unmatched_placeholders: string[]
  ambiguous_skipped: string[]
  exact_restore: boolean
  format: string
  path: string
  warnings: string[]
}

export const restoreFileOutput = {
  replacements_made: z.number(),
  unmatched_placeholders: z.array(z.string()),
  ambiguous_skipped: z.array(z.string()),
  exact_restore: z.boolean(),
  format: z.string(),
  path: z.string(),
  warnings: z.array(z.string()),
}

function stemOf(filename: string): string {
  return filename.replace(/\.[^.]+$/, '')
}

export function makeRestoreFileHandler(ctx: ToolContext) {
  return async (
    args: { path: string; output_filename?: string; project?: string },
    _extra: ToolExtra,
  ): Promise<CallToolResult> => {
    try {
      const guarded = await guardInputFile(args.path, ctx.config.allowedDirs)
      const session = await ctx.connect()
      const data = await readFile(guarded.path)
      const response = await session.backend.postMultipart<DeanonymizeFileResponse>(
        '/anonymization/deanonymize-file',
        { project_id: args.project ?? ctx.config.defaultProject },
        { field: 'file', filename: guarded.filename, data: new Uint8Array(data) },
      )

      let outputPath: string
      let format: string
      if (response.download !== null && response.download !== undefined) {
        const bytes = Buffer.from(response.download.file_base64, 'base64')
        outputPath = await writeOutputFile(
          ctx.config.outputDir,
          args.output_filename ?? response.download.filename,
          new Uint8Array(bytes),
        )
        format = response.download.format
      } else {
        // Text-only fallback, the backend could not preserve the format.
        outputPath = await writeOutputFile(
          ctx.config.outputDir,
          args.output_filename ?? `${stemOf(guarded.filename)}-restored.txt`,
          response.restored_text,
        )
        format = 'txt'
      }

      const result: RestoreFileToolResult = {
        replacements_made: response.replacements_made,
        unmatched_placeholders: response.unmatched_placeholders,
        ambiguous_skipped: response.ambiguous_skipped,
        exact_restore: response.exact_restore,
        format,
        path: outputPath,
        warnings: (response.warnings ?? []).map((w) => w.message),
      }

      const lines = [
        `Restored ${result.replacements_made} placeholders into ${outputPath} ` +
          `(${format}). The restored content does not appear in this chat. ` +
          'Tell the user where the file was written.',
      ]
      if (result.unmatched_placeholders.length > 0) {
        lines.push(`${CARD_UNMATCHED_LABEL}: ${result.unmatched_placeholders.join(', ')}`)
      }
      if (result.exact_restore) {
        lines.push(CARD_EXACT_RESTORE_LINE)
      }
      lines.push(...result.warnings)
      return textResult(lines.join('\n'), result as unknown as Record<string, unknown>)
    } catch (error) {
      return errorResult(error)
    }
  }
}

export function registerRestoreFile(server: McpServer, ctx: ToolContext): void {
  registerAppTool(
    server,
    'stript_restore_file',
    {
      title: 'Restore original values into a file',
      description: RESTORE_FILE_DESCRIPTION,
      inputSchema: restoreFileInput,
      outputSchema: restoreFileOutput,
      annotations: {
        title: 'Restore original values into a file',
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
      _meta: uiMeta(RESTORE_CARD_URI),
    },
    makeRestoreFileHandler(ctx),
  )
}
