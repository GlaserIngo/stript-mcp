import { registerAppTool } from '@modelcontextprotocol/ext-apps/server'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'

import { readClipboard } from '../clipboard.js'
import { RESULT_CARD_URI, uiMeta } from '../ui.js'
import { BridgeError } from '../errors.js'
import type { DocumentResponse } from '../types.js'
import { runAnonymizeFlow, type AnonymizeMode } from './anonymizeFlow.js'
import { errorResult, progressReporter, type ToolContext, type ToolExtra } from './shared.js'
import { anonymizeOutput } from './anonymizeFile.js'

export const ANONYMIZE_CLIPBOARD_DESCRIPTION =
  'Use this when the user says the sensitive text is on their clipboard. ' +
  'Never ask the user to paste sensitive content into the chat, ask them to ' +
  'copy it and call this tool instead. The clipboard is read locally on the ' +
  'device, anonymized by Stript, and only the anonymized text enters the ' +
  'conversation. Set mode to review when the user wants to check the ' +
  'detections in the Stript app first. Processing a new document uses one ' +
  'of the 5 Free Evaluation documents.'

export const anonymizeClipboardInput = {
  mode: z
    .enum(['auto', 'review'])
    .default('auto')
    .describe('auto anonymizes headlessly, review opens the Stript app for the user first'),
  project: z
    .string()
    .optional()
    .describe('Stript project id, defaults to the configured project'),
}

export function makeAnonymizeClipboardHandler(ctx: ToolContext) {
  return async (
    args: { mode: AnonymizeMode; project?: string },
    extra: ToolExtra,
  ): Promise<CallToolResult> => {
    const onProgress = progressReporter(extra)
    try {
      const text = await readClipboard()
      if (text.trim().length === 0) {
        throw new BridgeError(
          'The clipboard is empty. Ask the user to copy the sensitive text first.',
        )
      }
      const session = await ctx.connect()
      await onProgress('Sending the clipboard text to the local Stript app')
      const doc = await session.backend.postJson<DocumentResponse>('/documents/paste', {
        text,
        filename: 'clipboard.txt',
        project_id: args.project ?? ctx.config.defaultProject,
      })
      return await runAnonymizeFlow(ctx, session, doc, args.mode, 'the clipboard text', onProgress)
    } catch (error) {
      return errorResult(error)
    }
  }
}

/** Registered ONLY when clipboard access is enabled in config (default off). */
export function registerAnonymizeClipboard(server: McpServer, ctx: ToolContext): void {
  registerAppTool(
    server,
    'stript_anonymize_clipboard',
    {
      title: 'Anonymize the clipboard text with Stript',
      description: ANONYMIZE_CLIPBOARD_DESCRIPTION,
      inputSchema: anonymizeClipboardInput,
      outputSchema: anonymizeOutput,
      annotations: {
        title: 'Anonymize the clipboard text with Stript',
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
      _meta: uiMeta(RESULT_CARD_URI),
    },
    makeAnonymizeClipboardHandler(ctx),
  )
}
