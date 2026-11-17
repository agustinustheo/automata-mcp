import { createHmac, timingSafeEqual } from 'node:crypto'
import { assertNever } from '#shared/connection'

/**
 * Media downloads for WhatsApp and Telegram messages: the size caps, the
 * signed-URL format, and the shape of a tool result carrying a file. The
 * per-kind fetching lives in `whatsapp-media.ts` and `telegram-media.ts`.
 *
 * **Nothing is stored.** Bytes are fetched from Evolution or the bridge on each
 * call and handed straight back, the same rule as IMAP attachments. A signed
 * URL holds no bytes either: following it fetches the file again, after the
 * same checks the tool ran.
 *
 * **A signed URL is not a bearer credential.** It is a short-lived claim
 * ("this token may fetch this message's media until T"), and the route still
 * requires the very token it was minted for in the `Authorization` header, then
 * re-checks that token's tool and chat scope. A URL copied out of a transcript
 * is useless without the token; a token without a fresh URL can call the tool.
 */

/** How long a signed media URL works. Well under the 15 minutes asked of it. */
export const MEDIA_URL_TTL_SECONDS = 10 * 60

/** Image types every MCP client renders. Anything else goes back as an embedded file. */
const INLINE_IMAGE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

export type MediaKind = 'whatsapp' | 'telegram'

/** The tool whose grant a signed URL of this kind depends on. */
export function mediaToolFor(kind: MediaKind): string {
  switch (kind) {
    case 'whatsapp':
      return 'download-media'
    case 'telegram':
      return 'download-telegram-media'
    default:
      return assertNever(kind, 'media kind')
  }
}

/** The largest file fetched at all. */
export function mediaMaxBytes(): number {
  return positiveNumber(useRuntimeConfig().mediaMaxBytes, 25 * 1024 * 1024)
}

/** The largest file returned inside the tool result; above it, a signed URL. */
export function mediaInlineMaxBytes(): number {
  return Math.min(positiveNumber(useRuntimeConfig().mediaInlineMaxBytes, 5 * 1024 * 1024), mediaMaxBytes())
}

function positiveNumber(raw: unknown, fallback: number): number {
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? value : fallback
}

export function formatMediaBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** One downloaded file. */
export interface MediaFile {
  data: Buffer
  mimeType: string
  fileName?: string
}

/** What a caller is told about a file, with or without its bytes. */
export interface MediaMeta {
  /** `image`, `video`, `video-note`, `audio`, `voice`, `document`, `sticker` or `photo`. */
  mediaType: string
  mimeType: string
  fileName?: string
  /** Bytes, when known. Exact once downloaded; the sender's claim before. */
  size?: number
}

/**
 * A MIME type safe to put in a `Content-Type` header and a tool result. Anything
 * a sender wrote that does not look like `type/subtype` becomes octet-stream, so
 * a crafted value can neither inject a header nor ask a browser to render HTML.
 */
export function cleanMimeType(raw: unknown): string {
  if (typeof raw !== 'string') return 'application/octet-stream'
  const base = raw.split(';')[0]!.trim().toLowerCase()
  return /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/.test(base)
    ? base
    : 'application/octet-stream'
}

/** A sender-chosen file name, reduced to something that cannot carry a path or a control character. */
export function cleanFileName(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  // eslint-disable-next-line no-control-regex
  const name = raw.replace(/[\u0000-\u001f\u007f/\\]/g, '_').trim().slice(0, 200)
  return name && name !== '.' && name !== '..' ? name : undefined
}

/** The result for a file small enough to return inline. Same shapes as `get-email-attachment`. */
export function mediaInlineResult(meta: Record<string, unknown>, file: MediaFile) {
  const text = { type: 'text' as const, text: JSON.stringify({ ...meta, delivery: 'inline' }, null, 2) }
  if (INLINE_IMAGE.has(file.mimeType)) {
    return { content: [text, { type: 'image' as const, data: file.data.toString('base64'), mimeType: file.mimeType }] }
  }
  return {
    content: [
      text,
      {
        type: 'resource' as const,
        resource: {
          uri: `media:///${encodeURIComponent(file.fileName ?? 'file')}`,
          mimeType: file.mimeType,
          blob: file.data.toString('base64'),
        },
      },
    ],
  }
}

/** The result for a file handed back as a signed URL. */
export function mediaUrlResult(meta: Record<string, unknown>, url: string, expiresAt: Date) {
  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({
        ...meta,
        delivery: 'url',
        url,
        expiresAt: expiresAt.toISOString(),
        howToFetch: 'GET the url with the same Authorization: Bearer header as this MCP connection, '
          + 'before expiresAt. It works only for this connector token.',
      }, null, 2),
    }],
  }
}

// ── signed URLs ──────────────────────────────────────────────────────────────

/** What a signed URL claims. Short keys: it rides in a URL path. */
export interface MediaRef {
  v: 1
  /** Connection kind. */
  k: MediaKind
  /** Connection (instance) id. */
  i: string
  /** Token id the URL was minted for; only that token may follow it. */
  t: string
  /** Chat: a WhatsApp JID, or a Telegram marked chat id. */
  c: string
  /** Message id: WhatsApp's key id, or Telegram's numeric id as a string. */
  m: string
  /** Expiry, unix seconds. */
  e: number
}

/**
 * The signing key, derived from `NUXT_WEBHOOK_SECRET` under a label of its own,
 * so a value signed here can never pass as anything the webhook secret
 * authenticates, and no new secret has to be provisioned. Undefined when the
 * secret is unset; signed URLs are then unavailable and the tools say so.
 */
function signingKey(): Buffer | undefined {
  const secret = String(useRuntimeConfig().webhookSecret ?? '')
  if (!secret) return undefined
  return createHmac('sha256', secret).update('automata:media-url:v1').digest()
}

function mac(key: Buffer, payload: string): Buffer {
  return createHmac('sha256', key).update(payload).digest()
}

/**
 * An absolute signed URL for one message's media, or undefined when this
 * deployment cannot mint one (no webhook secret, or no public app URL to put in
 * front of it).
 */
export function signMediaUrl(ref: Omit<MediaRef, 'v' | 'e'>, now = Date.now()): { url: string, expiresAt: Date } | undefined {
  const key = signingKey()
  const appUrl = String(useRuntimeConfig().public.appUrl ?? '').trim().replace(/\/+$/, '')
  if (!key || !appUrl) return undefined

  const expiresAt = new Date(now + MEDIA_URL_TTL_SECONDS * 1000)
  const full: MediaRef = { v: 1, ...ref, e: Math.floor(expiresAt.getTime() / 1000) }
  const payload = Buffer.from(JSON.stringify(full)).toString('base64url')
  const signature = mac(key, payload).toString('base64url')
  return { url: `${appUrl}${MEDIA_ROUTE_PREFIX}${payload}.${signature}`, expiresAt }
}

export type MediaRefCheck =
  | { ok: true, ref: MediaRef }
  | { ok: false, reason: 'invalid' | 'expired' }

/** Verify a signed blob: signature first (constant time), then shape, then expiry. */
export function verifyMediaRef(blob: string | undefined, now = Date.now()): MediaRefCheck {
  const key = signingKey()
  if (!key || !blob || blob.length > 2048) return { ok: false, reason: 'invalid' }
  const dot = blob.lastIndexOf('.')
  if (dot <= 0) return { ok: false, reason: 'invalid' }
  const payload = blob.slice(0, dot)
  const given = Buffer.from(blob.slice(dot + 1), 'base64url')
  const expected = mac(key, payload)
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, reason: 'invalid' }

  let ref: MediaRef
  try {
    ref = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as MediaRef
  }
  catch {
    return { ok: false, reason: 'invalid' }
  }
  if (ref?.v !== 1 || (ref.k !== 'whatsapp' && ref.k !== 'telegram')
    || typeof ref.i !== 'string' || typeof ref.t !== 'string' || typeof ref.c !== 'string'
    || typeof ref.m !== 'string' || typeof ref.e !== 'number') {
    return { ok: false, reason: 'invalid' }
  }
  if (ref.e * 1000 <= now) return { ok: false, reason: 'expired' }
  return { ok: true, ref }
}

/** Refusal when a file needs a URL and this deployment cannot sign one. */
export function signedUrlUnavailable(size: number | undefined, inlineMax: number) {
  console.error('[media] signed URL unavailable: NUXT_WEBHOOK_SECRET or NUXT_PUBLIC_APP_URL is not set')
  return createError({
    statusCode: 501,
    message: (size !== undefined ? `This file is ${formatMediaBytes(size)}, over the ${formatMediaBytes(inlineMax)} returned inline, and ` : '')
      + 'this server cannot issue download links (its operator has not set NUXT_WEBHOOK_SECRET and NUXT_PUBLIC_APP_URL).',
  })
}

/** `Content-Disposition` for a download, with the name in both plain and RFC 5987 form. */
export function attachmentDisposition(fileName: string | undefined): string {
  if (!fileName) return 'attachment'
  const ascii = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`
}
