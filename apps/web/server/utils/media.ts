import type { H3Event } from 'h3'

/**
 * Media downloads for WhatsApp messages: the size cap, bounded reads, and the
 * shape of a tool result carrying a file. The fetching lives in
 * `whatsapp-media.ts`.
 *
 * **Nothing is stored.** Bytes are fetched from Evolution on each call and
 * handed straight back, the same rule as IMAP attachments.
 *
 * **Memory is bounded before bytes are held.** A sender's reported size is a
 * claim, so Evolution's answer (one JSON body with the whole file as base64) is
 * read through `fetchBase64Media`, which decodes the file as it streams and
 * stops at the cap rather than parsing whatever arrives. At most
 * `MEDIA_DOWNLOADS_IN_FLIGHT` downloads run at once in this process, one per
 * connection (`acquireMediaSlot`), each slot held until its file has been
 * delivered in the tool result or the delivery guard cut it off
 * (`deliveryGuard`: deadline, caller gone).
 */

/** Downloads one process runs at once; more are refused with 429, never queued. */
const MEDIA_DOWNLOADS_IN_FLIGHT = 3
/** Downloads one connection runs at once, so one connection cannot hold every slot. */
const MEDIA_DOWNLOADS_PER_CONNECTION = 1
/**
 * Longest an inline result may take to reach the caller. Past it the response is cut off and its slot given back: a
 * caller that stops reading must not hold a slot, and the file, for ever.
 */
const MEDIA_DELIVERY_DEADLINE_MS = 5 * 60_000
/** Image types every MCP client renders. Anything else goes back as an embedded file. */
const INLINE_IMAGE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

/** The largest file fetched and returned inside the tool result; larger ones are refused. */
export function mediaInlineMaxBytes(): number {
  return positiveNumber(useRuntimeConfig().mediaInlineMaxBytes, 5 * 1024 * 1024)
}

function positiveNumber(raw: unknown, fallback: number): number {
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? value : fallback
}

/** One downloaded file. */
export interface MediaFile {
  data: Buffer
  mimeType: string
  fileName?: string
}

/** What a caller is told about a file, with or without its bytes. */
export interface MediaMeta {
  /** `image`, `video`, `video-note`, `audio`, `voice`, `document` or `sticker`. */
  mediaType: string
  mimeType: string
  fileName?: string
  /** Bytes, when known. Exact once downloaded; the sender's claim before. */
  size?: number
}

/**
 * A MIME type safe to put in a tool result: anything a sender wrote that does
 * not look like `type/subtype` becomes octet-stream. This is syntax only —
 * `text/html` passes.
 */
export function cleanMimeType(raw: unknown): string {
  if (typeof raw !== 'string') return 'application/octet-stream'
  const base = raw.split(';')[0]!.trim().toLowerCase()
  return /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/.test(base)
    ? base
    : 'application/octet-stream'
}

/**
 * A sender-chosen file name, reduced to something that cannot carry a path or a
 * control character. Made well-formed and clipped by code point, never by UTF-16
 * unit: a split surrogate pair makes `encodeURIComponent` throw.
 */
export function cleanFileName(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const wellFormed = (raw as string & { toWellFormed(): string }).toWellFormed()
  // eslint-disable-next-line no-control-regex
  const name = Array.from(wellFormed.replace(/[\u0000-\u001f\u007f/\\]/g, '_').trim()).slice(0, 200).join('')
  return name && name !== '.' && name !== '..' ? name : undefined
}

/** The result for a file small enough to return inline. Same shapes as `get-email-attachment`. */
export function mediaInlineResult(meta: Record<string, unknown>, file: MediaFile) {
  const text = { type: 'text' as const, text: JSON.stringify(meta, null, 2) }
  if (INLINE_IMAGE.has(file.mimeType)) {
    return { content: [text, { type: 'image' as const, data: file.data.toString('base64'), mimeType: file.mimeType }] }
  }
  return {
    content: [
      text,
      {
        type: 'resource' as const,
        resource: {
          uri: `media:///${rfc5987(file.fileName ?? 'file')}`,
          mimeType: file.mimeType,
          blob: file.data.toString('base64'),
        },
      },
    ],
  }
}

// ── bounded work ─────────────────────────────────────────────────────────────

let inFlight = 0
const inFlightByConnection = new Map<string, number>()

/**
 * Take one of this process's few media slots for this connection, or refuse
 * with 429; the caller must call the returned release exactly once. A download
 * holds its file until it has been delivered, so the number in flight is what
 * bounds the memory held, whatever the per-minute budgets allow. One connection gets one slot at a
 * time, so a slow reader on one connection cannot shut every other out.
 */
export function acquireMediaSlot(connectionId: string): () => void {
  if (inFlight >= MEDIA_DOWNLOADS_IN_FLIGHT) {
    throw createError({
      statusCode: 429,
      message: 'Too many file downloads are in progress on this server. Try again in a few seconds.',
    })
  }
  const own = inFlightByConnection.get(connectionId) ?? 0
  if (own >= MEDIA_DOWNLOADS_PER_CONNECTION) {
    throw createError({
      statusCode: 429,
      message: 'Another file download on this connection is still in progress. Try again when it has finished.',
    })
  }
  inFlight++
  inFlightByConnection.set(connectionId, own + 1)
  let released = false
  return () => {
    if (released) return
    released = true
    inFlight--
    const left = (inFlightByConnection.get(connectionId) ?? 1) - 1
    if (left > 0) inFlightByConnection.set(connectionId, left)
    else inFlightByConnection.delete(connectionId)
  }
}

/**
 * Run one download for an inline tool result in a media slot. A failure gives
 * the slot back at once; a result keeps it until the MCP response carrying the
 * file has been sent (`holdUntilDelivered`), so the slots bound the files held
 * by slow callers too. One download per connection, so a second download call
 * in the same JSON-RPC batch is refused (429).
 */
export async function withMediaSlot<T>(connectionId: string, work: () => Promise<T>): Promise<T> {
  const release = acquireMediaSlot(connectionId)
  let result: T
  try {
    result = await work()
  }
  catch (error) {
    release()
    throw error
  }
  holdUntilDelivered(useEvent(), release)
  return result
}

/**
 * When an inline result's response must stop: the caller went away, or
 * `MEDIA_DELIVERY_DEADLINE_MS` passed. No stall check: the MCP toolkit writes
 * the result in one go after the tool returns (and after any slower call in
 * the same batch), so there is nothing paced to measure. `stop()` clears the
 * timer.
 */
function deliveryGuard(event: H3Event): { signal: AbortSignal, stop: () => void } {
  const cut = new AbortController()
  const deadline = setTimeout(() => cut.abort(new Error('media delivery deadline passed')), MEDIA_DELIVERY_DEADLINE_MS)
  deadline.unref?.()
  return {
    signal: AbortSignal.any([requestAbortSignal(event), cut.signal]),
    stop: () => clearTimeout(deadline),
  }
}

/**
 * Keep a slot until this request's response has been sent — for an inline
 * result, whose file sits in the MCP response the toolkit writes after the tool
 * returns. A response that outlives the deadline is destroyed, and the slot
 * comes back either way.
 */
function holdUntilDelivered(event: H3Event, release: () => void): void {
  const res = event.node.res
  if (res.closed || res.destroyed) {
    release()
    return
  }
  const guard = deliveryGuard(event)
  const onStop = () => res.destroy()
  guard.signal.addEventListener('abort', onStop, { once: true })
  res.once('close', () => {
    guard.signal.removeEventListener('abort', onStop)
    guard.stop()
    release()
  })
}

/**
 * The JSON body that carries a file of at most `maxBytes`, base64-encoded, plus
 * room for the fields around it. Anything longer cannot be within the cap.
 */
export function cappedBodyBytes(maxBytes: number): number {
  return Math.ceil(maxBytes / 3) * 4 + 256 * 1024
}

/** Shape of an HTTP failure as `httpStatusOf` reads it (like ofetch's). */
export class MediaFetchError extends Error {
  constructor(public status: number, public data: unknown) {
    super(`media fetch answered ${status}`)
    this.name = 'MediaFetchError'
  }
}

/**
 * GET or POST through an ofetch client and read the JSON answer that carries
 * one file of at most `maxFileBytes` as a base64 field named `field`, decoding
 * that field **as it streams** (`Base64FieldReader`): the file is held once,
 * decoded, never also as the answer's bytes, its text and its base64 string.
 * Answers the rest of the object, parsed, and the file (undefined when the
 * field is absent).
 *
 * Bounded before bytes are held: an answer longer than the file's base64 plus
 * room for the fields around it (`cappedBodyBytes`) — by its Content-Length,
 * or by the count as it streams — and a decoded file past `maxFileBytes` are
 * refused with 413, the stream cancelled. An answer that is not the expected
 * shape is a plain error (callers report it as the server failing).
 *
 * An error answer is read up to 64 KiB and the rest dropped — a long error page
 * is still an error, not an oversized file — then thrown as `MediaFetchError`,
 * carrying the status and parsed body the callers' error mapping expects.
 */
export async function fetchBase64Media<T>(
  client: typeof $fetch,
  url: string,
  options: Record<string, unknown>,
  field: string,
  maxFileBytes: number,
): Promise<{ fields: T | null, data: Buffer | undefined }> {
  const response = await client.raw(url, { ...options, responseType: 'stream', ignoreResponseError: true })
  const stream = response._data as ReadableStream<Uint8Array> | undefined
  if (!response.ok) {
    const text = stream ? (await readCapped(stream, 64 * 1024)).text : ''
    throw new MediaFetchError(response.status, safeJson(text))
  }
  const tooLarge = () => createError({ statusCode: 413, message: `This file is larger than the ${formatBytes(maxFileBytes)} this connector fetches.` })
  if (!stream) return { fields: null, data: undefined }

  const bodyLimit = cappedBodyBytes(maxFileBytes)
  const declared = Number(response.headers.get('content-length') ?? '')
  const known = Number.isSafeInteger(declared) && declared > 0
  if (known && declared > bodyLimit) {
    await stream.cancel().catch(() => {})
    throw tooLarge()
  }
  // Content-Length sizes the output only for an uncompressed answer: compressed,
  // it counts the compressed bytes, not the base64 this reads after decoding.
  const sized = known && !response.headers.get('content-encoding')
  const reader = new Base64FieldReader(field, maxFileBytes, sized ? Math.floor(declared * 3 / 4) : undefined)
  const source = stream.getReader()
  let size = 0
  try {
    for (;;) {
      const { done, value } = await source.read()
      if (done) break
      size += value.byteLength
      if (size > bodyLimit) throw tooLarge()
      reader.push(value)
    }
    const { json, data } = reader.end()
    return { fields: JSON.parse(json) as T | null, data }
  }
  catch (error) {
    await source.cancel().catch(() => {})
    if (error instanceof Base64FieldError && error.reason === 'too-large') throw tooLarge()
    throw error
  }
}

/** At most `limit` bytes of a stream as text; past it, the stream is cancelled and `truncated` set. */
async function readCapped(stream: ReadableStream<Uint8Array>, limit: number): Promise<{ text: string, truncated: boolean }> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (size + value.byteLength > limit) {
      chunks.push(value.subarray(0, limit - size))
      await reader.cancel().catch(() => {})
      return { text: Buffer.concat(chunks).toString('utf8'), truncated: true }
    }
    size += value.byteLength
    chunks.push(value)
  }
  const whole = Buffer.concat(chunks)
  chunks.length = 0
  return { text: whole.toString('utf8'), truncated: false }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  }
  catch {
    return undefined
  }
}

/** `encodeURIComponent` plus the four characters RFC 5987 does not allow bare. */
function rfc5987(value: string): string {
  return encodeURIComponent(value).replace(/['()*!]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
}
