import os from 'node:os'
import path from 'node:path'

/** Bridge configuration, parsed from the environment (contract section 7). */
export interface BridgeConfig {
  /** Allowlist of directories file reads may come from. */
  allowedDirs: string[]
  /** Where restored files and oversized anonymized text are written. */
  outputDir: string
  /** Registers the clipboard tool when true. Default off. */
  enableClipboard: boolean
  /** Project id used for mapping consistency. */
  defaultProject: string
  /** Seconds before review mode returns pending_review. */
  reviewTimeoutSeconds: number
  /** Discovery-file location, {dataDir}/integration.json. */
  dataDir: string
}

/** Expand a leading "~" to the user's home directory. */
export function expandHome(p: string): string {
  if (p === '~') return os.homedir()
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    return path.join(os.homedir(), p.slice(2))
  }
  return p
}

function parseBool(value: string | undefined): boolean {
  if (value === undefined) return false
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase())
}

/** Parse the bridge configuration from environment variables.
 *
 * | Env | Default |
 * |---|---|
 * | STRIPT_MCP_ALLOWED_DIRS | ~/Documents, ~/Desktop, ~/Downloads (path-separator-joined) |
 * | STRIPT_MCP_OUTPUT_DIR | ~/Documents/Stript |
 * | STRIPT_MCP_ENABLE_CLIPBOARD | false |
 * | STRIPT_MCP_DEFAULT_PROJECT | default |
 * | STRIPT_MCP_REVIEW_TIMEOUT | 600 seconds |
 * | STRIPT_DATA_DIR | ~/.stript |
 *
 * Allowed directories may also arrive as command-line arguments after an
 * `--allowed-dirs` flag (each directory as its own argument). This is the
 * .mcpb path: the manifest expands a multiple-directory user_config into
 * separate args, which the spec documents, while env expansion of multiple
 * values is unspecified. Argv wins over the env variable.
 */
export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  argv: readonly string[] = process.argv.slice(2),
): BridgeConfig {
  const home = os.homedir()

  const flagIndex = argv.indexOf('--allowed-dirs')
  const argvDirs =
    flagIndex >= 0
      ? argv
          .slice(flagIndex + 1)
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0 && !entry.startsWith('--'))
      : []

  const allowedRaw = env.STRIPT_MCP_ALLOWED_DIRS
  const allowedList =
    argvDirs.length > 0
      ? argvDirs
      : allowedRaw !== undefined && allowedRaw.trim().length > 0
        ? allowedRaw
            .split(path.delimiter)
            .map((entry) => entry.trim())
            .filter((entry) => entry.length > 0)
        : [
            path.join(home, 'Documents'),
            path.join(home, 'Desktop'),
            path.join(home, 'Downloads'),
          ]

  // Default 90: chat clients hard-cancel long tool calls (Claude Desktop at
  // 240 seconds, observed), and a cancelled call delivers NOTHING, not even
  // the pending_review handle. Handing back a resumable pending_review well
  // before any client cap is strictly better than waiting longer.
  const timeoutRaw = Number.parseInt(env.STRIPT_MCP_REVIEW_TIMEOUT ?? '', 10)
  const reviewTimeoutSeconds =
    Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? timeoutRaw : 90

  return {
    allowedDirs: allowedList.map((dir) => path.resolve(expandHome(dir))),
    outputDir: path.resolve(
      expandHome(env.STRIPT_MCP_OUTPUT_DIR ?? path.join(home, 'Documents', 'Stript')),
    ),
    enableClipboard: parseBool(env.STRIPT_MCP_ENABLE_CLIPBOARD),
    defaultProject:
      env.STRIPT_MCP_DEFAULT_PROJECT !== undefined &&
      env.STRIPT_MCP_DEFAULT_PROJECT.trim().length > 0
        ? env.STRIPT_MCP_DEFAULT_PROJECT.trim()
        : 'default',
    reviewTimeoutSeconds,
    dataDir: path.resolve(expandHome(env.STRIPT_DATA_DIR ?? path.join(home, '.stript'))),
  }
}
