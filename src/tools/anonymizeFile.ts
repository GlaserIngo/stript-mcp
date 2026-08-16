import { readFile } from 'node:fs/promises'

import { registerAppTool } from '@modelcontextprotocol/ext-apps/server'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'

import { guardInputFile } from '../files.js'
import { RESULT_CARD_URI, uiMeta } from '../ui.js'
import type { DocumentResponse } from '../types.js'
import { runAnonymizeFlow, type AnonymizeMode } from './anonymizeFlow.js'
import { errorResult, progressReporter, type ToolContext, type ToolExtra } from './shared.js'

export const ANONYMIZE_FILE_DESCRIPTION =
  'Use this when the user wants to work with a document that may contain ' +
  'personal data, for example summarize it, translate it, or draft a reply. ' +
  'Ask the user for the file path. Never ask the user to paste document ' +
  'content into the chat. Stript detects and replaces personal data locally ' +
  'and only the anonymized text enters the conversation. Placeholders like ' +
  '[PERSON_1] can be restored later with stript_restore. Set mode to review ' +
  'when the user wants to check the detections in the Stript app first, ' +
  'Stript then opens the document and you wait for the user. Processing a ' +
  'new document uses one of the 5 Free Evaluation documents, already ' +
  'processed documents are free.'

export const anonymizeFileInput = {
  path: z.string().min(1).describe('Absolute or ~ path of the document to anonymize'),
  mode: z
    .enum(['auto', 'review'])
    .default('auto')
    .describe('auto anonymizes headlessly, review opens the Stript app for the user first'),
  project: z
    .string()
    .optional()
    .describe('Stript project id, defaults to the configured project'),
}

export const anonymizeOutput = {
  document_id: z.string().optional(),
  project_id: z.string().optional(),
  status: z.string(),
  anonymized_text: z.string().optional(),
  output_file: z.string().optional(),
  detections_total: z.number().optional(),
  replacements: z.number().optional(),
  types: z.record(z.string(), z.number()).optional(),
  residual_risk: z
    .object({ flagged: z.boolean(), categories: z.array(z.string()) })
    .optional(),
  evaluation: z
    .object({ credit_status: z.string(), remaining: z.number() })
    .optional(),
  warnings: z.array(z.string()).optional(),
  reduced_accuracy: z.boolean().optional(),
  degraded_reasons: z.array(z.string()).optional(),
  next: z.string().optional(),
}

export function makeAnonymizeFileHandler(ctx: ToolContext) {
  return async (
    args: { path: string; mode: AnonymizeMode; project?: string },
    extra: ToolExtra,
  ): Promise<CallToolResult> => {
    const onProgress = progressReporter(extra)
    try {
      const guarded = await guardInputFile(args.path, ctx.config.allowedDirs)
      const session = await ctx.connect()
      const data = await readFile(guarded.path)
      await onProgress(`Uploading ${guarded.filename} to the local Stript app`)
      const doc = await session.backend.postMultipart<DocumentResponse>(
        '/documents/upload',
        { project_id: args.project ?? ctx.config.defaultProject },
        { field: 'file', filename: guarded.filename, data: new Uint8Array(data) },
      )
      return await runAnonymizeFlow(ctx, session, doc, args.mode, guarded.filename, onProgress)
    } catch (error) {
      return errorResult(error)
    }
  }
}

export function registerAnonymizeFile(server: McpServer, ctx: ToolContext): void {
  registerAppTool(
    server,
    'stript_anonymize_file',
    {
      title: 'Anonymize a document with Stript',
      description: ANONYMIZE_FILE_DESCRIPTION,
      inputSchema: anonymizeFileInput,
      outputSchema: anonymizeOutput,
      annotations: {
        title: 'Anonymize a document with Stript',
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
      _meta: uiMeta(RESULT_CARD_URI),
    },
    makeAnonymizeFileHandler(ctx),
  )
}
