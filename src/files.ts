import { mkdir, realpath, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { expandHome } from './config.js'
import { BridgeError } from './errors.js'

/** Extensions the backend upload surface supports. */
export const SUPPORTED_EXTENSIONS = [
  '.pdf',
  '.docx',
  '.txt',
  '.eml',
  '.msg',
  '.csv',
  '.rtf',
  '.odt',
  '.xlsx',
] as const

export const MAX_FILE_BYTES = 50 * 1024 * 1024

export class FileGuardError extends BridgeError {
  constructor(message: string) {
    super(message)
    this.name = 'FileGuardError'
  }
}

export interface GuardedFile {
  /** The resolved real path. */
  path: string
  filename: string
  size: number
}

/** Validate a user-supplied input path (contract section 7 file guards).
 *
 * Order: realpath first (symlinks resolve before any check), regular file,
 * inside an allowed directory, supported extension, no path component
 * starting with a dot after the allowed root, max 50 MB.
 */
export async function guardInputFile(
  rawPath: string,
  allowedDirs: string[],
): Promise<GuardedFile> {
  const expanded = path.resolve(expandHome(rawPath.trim()))

  let real: string
  try {
    real = await realpath(expanded)
  } catch {
    throw new FileGuardError(`The file was not found: ${expanded}`)
  }

  const info = await stat(real)
  if (!info.isFile()) {
    throw new FileGuardError('The path does not point to a regular file.')
  }

  let insideRoot: string | null = null
  let relative = ''
  for (const dir of allowedDirs) {
    let realDir: string
    try {
      realDir = await realpath(path.resolve(expandHome(dir)))
    } catch {
      continue
    }
    const rel = path.relative(realDir, real)
    if (rel.length > 0 && !rel.startsWith('..') && !path.isAbsolute(rel)) {
      insideRoot = realDir
      relative = rel
      break
    }
  }
  if (insideRoot === null) {
    throw new FileGuardError(
      'The file is outside the allowed folders. Allowed folders: ' +
        `${allowedDirs.join(', ')}. Set STRIPT_MCP_ALLOWED_DIRS to change this.`,
    )
  }

  const ext = path.extname(real).toLowerCase()
  if (!(SUPPORTED_EXTENSIONS as readonly string[]).includes(ext)) {
    throw new FileGuardError(
      `Unsupported file type ${ext.length > 0 ? ext : '(no extension)'}. ` +
        `Supported types: ${SUPPORTED_EXTENSIONS.join(', ')}`,
    )
  }

  for (const component of relative.split(path.sep)) {
    if (component.startsWith('.')) {
      throw new FileGuardError(
        'Files inside hidden folders or with names starting with a dot are not allowed.',
      )
    }
  }

  if (info.size > MAX_FILE_BYTES) {
    throw new FileGuardError('The file is larger than the 50 MB limit.')
  }

  return { path: real, filename: path.basename(real), size: info.size }
}

/** Reduce a desired output name to a safe basename. */
export function sanitizeFilename(desired: string): string {
  const base = path.basename(desired.trim())
  const cleaned = base
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/[/\\:*?"<>|]/g, '_')
    .replace(/^\.+/, '')
    .trim()
  return cleaned.length > 0 ? cleaned : 'restored.txt'
}

/** Write data under the output directory, never overwriting an existing
 * file. On a name collision the writer suffixes -1, -2, and so on before
 * the extension. Returns the final absolute path. */
export async function writeOutputFile(
  outputDir: string,
  desiredName: string,
  data: Uint8Array | string,
): Promise<string> {
  const dir = path.resolve(expandHome(outputDir))
  await mkdir(dir, { recursive: true })
  const safe = sanitizeFilename(desiredName)
  const ext = path.extname(safe)
  const stem = safe.slice(0, safe.length - ext.length)

  for (let attempt = 0; attempt < 10_000; attempt++) {
    const name = attempt === 0 ? safe : `${stem}-${attempt}${ext}`
    const candidate = path.join(dir, name)
    try {
      // wx: fail when the path exists, so concurrent writers cannot clobber.
      await writeFile(candidate, data, { flag: 'wx' })
      return candidate
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'EEXIST') continue
      throw error
    }
  }
  throw new BridgeError('Could not find a free output file name.')
}
