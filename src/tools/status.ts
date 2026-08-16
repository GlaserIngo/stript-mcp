import { registerAppTool } from '@modelcontextprotocol/ext-apps/server'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'

import { BackendClient } from '../backendClient.js'
import { STATUS_CARD_URI, uiMeta } from '../ui.js'
import { BrokerClient } from '../brokerClient.js'
import { NO_FILE_GUIDANCE, readDiscoveryFile, UNREACHABLE_GUIDANCE } from '../discovery.js'
import { BridgeError } from '../errors.js'
import type { HealthResponse, LicenseStatusResponse } from '../types.js'
import { errorResult, textResult, type ToolContext, type ToolExtra } from './shared.js'

export const STATUS_DESCRIPTION =
  'Use this to check whether the Stript desktop app is running with AI ' +
  'integrations enabled, which license tier is active, and how many Free ' +
  'Evaluation documents remain. Call it before anonymizing when the state ' +
  'is unclear. It consumes no evaluation document and changes nothing.'

export const statusOutput = {
  app_running: z.boolean(),
  app_version: z.string().optional(),
  backend_version: z.string().optional(),
  integration_enabled: z.boolean(),
  tier: z.string().optional(),
  evaluation_remaining: z.number().optional(),
  models_ready: z.boolean().optional(),
  guidance: z.string().optional(),
}

export function makeStatusHandler(ctx: ToolContext) {
  return async (_args: Record<string, never>, _extra: ToolExtra): Promise<CallToolResult> => {
    try {
      let discovery
      try {
        discovery = await readDiscoveryFile(ctx.config.dataDir)
      } catch (error) {
        // Version mismatch carries its own actionable text.
        if (error instanceof BridgeError) {
          return textResult(error.message, {
            app_running: false,
            integration_enabled: false,
            guidance: error.message,
          })
        }
        throw error
      }
      if (discovery === null) {
        return textResult(NO_FILE_GUIDANCE, {
          app_running: false,
          integration_enabled: false,
          guidance: NO_FILE_GUIDANCE,
        })
      }

      const backend = new BackendClient(
        `http://127.0.0.1:${discovery.backend_port}/api`,
        discovery.token,
      )
      const broker = new BrokerClient(
        `http://127.0.0.1:${discovery.broker_port}/v1`,
        discovery.token,
      )

      let health: HealthResponse
      let license: LicenseStatusResponse
      try {
        ;[health, license] = await Promise.all([
          backend.getJson<HealthResponse>('/health'),
          backend.getJson<LicenseStatusResponse>('/license/status'),
        ])
        await broker.info()
      } catch {
        return textResult(UNREACHABLE_GUIDANCE, {
          app_running: false,
          integration_enabled: false,
          guidance: UNREACHABLE_GUIDANCE,
        })
      }

      const modelsLoaded = health.models_loaded ?? {}
      const modelValues = Object.values(modelsLoaded)
      const modelsReady = modelValues.length > 0 && modelValues.every((loaded) => loaded)

      const structured: Record<string, unknown> = {
        app_running: true,
        app_version: discovery.app_version,
        backend_version: health.version,
        integration_enabled: true,
        tier: license.tier,
        evaluation_remaining: license.usage.remaining,
        models_ready: modelsReady,
      }
      const remainingText =
        license.usage.remaining === -1
          ? 'unlimited document processing (Pro)'
          : `${license.usage.remaining} of ${license.usage.limit} Free Evaluation documents remaining`
      const text =
        `Stript ${discovery.app_version} is running with AI integrations ` +
        `enabled. Tier: ${license.tier}, ${remainingText}. Detection models ` +
        `${modelsReady ? 'are loaded' : 'are not fully loaded yet, the first run may take longer'}.`
      return textResult(text, structured)
    } catch (error) {
      return errorResult(error)
    }
  }
}

export function registerStatus(server: McpServer, ctx: ToolContext): void {
  registerAppTool(
    server,
    'stript_status',
    {
      title: 'Check the Stript app status',
      description: STATUS_DESCRIPTION,
      inputSchema: {},
      outputSchema: statusOutput,
      annotations: {
        title: 'Check the Stript app status',
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
      _meta: uiMeta(STATUS_CARD_URI),
    },
    makeStatusHandler(ctx),
  )
}
