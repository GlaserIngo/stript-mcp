import { StriptApiError } from './errors.js'

/** One parsed server-sent event. */
export interface SSEEvent {
  event: string
  data: string
}

/** Parse complete SSE blocks from text (mirror of frontend/src/lib/sse-parser.ts). */
export function parseSSEEvents(text: string): SSEEvent[] {
  const events: SSEEvent[] = []
  for (const block of text.split('\n\n')) {
    const trimmed = block.trim()
    if (!trimmed) continue
    let event = 'message'
    const dataLines: string[] = []
    for (const line of trimmed.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim()
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart())
    }
    if (dataLines.length) events.push({ event, data: dataLines.join('\n') })
  }
  return events
}

/** Stateful SSE parser that retains incomplete transport chunks. */
export class SSEChunkParser {
  private buffer = ''

  push(chunk: string): SSEEvent[] {
    this.buffer += chunk.replace(/\r\n/g, '\n')
    const boundary = this.buffer.lastIndexOf('\n\n')
    if (boundary < 0) return []
    const complete = this.buffer.slice(0, boundary + 2)
    this.buffer = this.buffer.slice(boundary + 2)
    return parseSSEEvents(complete)
  }
}

async function buildApiError(response: Response): Promise<StriptApiError> {
  let errorCode = `HTTP_${response.status}`
  let detail = ''
  try {
    const body = (await response.json()) as { error_code?: string; detail?: string }
    if (typeof body.error_code === 'string' && body.error_code.length > 0) {
      errorCode = body.error_code
    }
    if (typeof body.detail === 'string') detail = body.detail
  } catch {
    // Non-JSON error body, keep the status-derived code.
  }
  return new StriptApiError(response.status, errorCode, detail)
}

/** Thin fetch wrapper for the FastAPI sidecar, authenticated with the
 * per-launch integration token as X-Stript-Token. */
export class BackendClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  private headers(extra?: Record<string, string>): Record<string, string> {
    return { 'X-Stript-Token': this.token, ...extra }
  }

  async getJson<T>(path: string): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      headers: this.headers(),
    })
    if (!response.ok) throw await buildApiError(response)
    return (await response.json()) as T
  }

  async postJson<T>(path: string, body: unknown, extraHeaders?: Record<string, string>): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/json', ...extraHeaders }),
      body: JSON.stringify(body),
    })
    if (!response.ok) throw await buildApiError(response)
    return (await response.json()) as T
  }

  async postMultipart<T>(
    path: string,
    fields: Record<string, string>,
    file: { field: string; filename: string; data: Uint8Array },
  ): Promise<T> {
    const form = new FormData()
    const view = new Uint8Array(file.data)
    form.append(
      file.field,
      new Blob([view.buffer as ArrayBuffer], { type: 'application/octet-stream' }),
      file.filename,
    )
    for (const [key, value] of Object.entries(fields)) form.append(key, value)
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: this.headers(),
      body: form,
    })
    if (!response.ok) throw await buildApiError(response)
    return (await response.json()) as T
  }

  /** POST the detect SSE request and yield parsed events.
   *
   * Mirrors the app's stream semantics: one retry with ?force=true on a 409
   * (stuck "detecting" status from an aborted run). The CALLER enforces
   * terminal-event semantics, a stream that ends without a terminal
   * complete or error event is a failure, never a completed run.
   */
  async *detectStream(documentId: string, permit: string | null): AsyncGenerator<SSEEvent, void, void> {
    const url = `${this.baseUrl}/documents/${documentId}/detect`
    const init: RequestInit = {
      method: 'POST',
      headers: this.headers({
        Accept: 'text/event-stream',
        ...(permit !== null ? { 'X-Stript-Evaluation-Permit': permit } : {}),
      }),
    }
    let response = await fetch(url, init)
    if (response.status === 409) {
      // Mirror useDetectionStream: exactly one recovery retry with force=true.
      response = await fetch(`${url}?force=true`, init)
    }
    if (!response.ok) throw await buildApiError(response)
    if (!response.body) {
      throw new StriptApiError(0, 'EMPTY_STREAM', 'The detection stream returned no body.')
    }
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    const parser = new SSEChunkParser()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        for (const evt of parser.push(decoder.decode(value, { stream: true }))) {
          yield evt
        }
      }
    } finally {
      // Release the connection when the caller stops consuming early
      // (for example right after the terminal event).
      try {
        await reader.cancel()
      } catch {
        // Already closed.
      }
    }
  }
}
