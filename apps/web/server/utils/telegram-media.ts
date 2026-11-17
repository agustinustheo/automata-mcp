import type { McpAuth } from './mcp-auth'

type TelegramAuth = Extract<McpAuth, { kind: 'telegram' }>

/**
 * Telegram media for one message, through the bridge. Shared by the
 * `download-telegram-media` tool and the signed-URL route, so both run the same
 * checks. The caller asserts chat scope first (`assertChatAllowed`); the bridge
 * then fetches the message through that chat and refuses one from any other.
 *
 * **Streamed, never stored.** The bridge sends the file as raw bytes, chunk by
 * chunk, as it downloads them from Telegram. The signed-URL route pipes that
 * stream straight to the caller (`pipeMediaToResponse`, with backpressure), so
 * no layer holds the whole file. Only an inline tool result reads it into memory, because MCP
 * carries the file inside the JSON result; that read is capped at the inline
 * limit (5 MiB by default).
 */

/** The bridge's own ceiling on one download (`MEDIA_MAX_BYTES` in apps/telegram-bridge/src/http.ts). */
const BRIDGE_MEDIA_MAX_BYTES = 50 * 1024 * 1024
/** The bridge's download chunk (`requestSize` in its `media`): how far short of the cap it may cut. */
const BRIDGE_CHUNK_BYTES = 512 * 1024

/**
 * The synced message's media kind, or a loud refusal: 404 when no such
 * message is synced in this chat, 422 when it carries no media.
 */
export async function findTelegramMedia(auth: TelegramAuth, chatId: string, messageId: number): Promise<string> {
  const media = await telegramMessageMedia(auth.instance, chatId, messageId)
  if (media === undefined) {
    throw createError({
      statusCode: 404,
      message: `No message ${messageId} is synced in chat ${chatId}. Pass ids exactly as read-telegram-messages returned them.`,
    })
  }
  if (media === null) {
    throw createError({ statusCode: 422, message: 'This message carries no media.' })
  }
  return media
}

/**
 * Open the file as a byte stream from the bridge, with what the bridge says
 * about it. The bridge refuses a file over `maxBytes` from Telegram's reported
 * size before sending anything (413, keeping that size so a caller can tell
 * "too large for inline" from "too large at all") and cuts the stream off if
 * the bytes pass it anyway.
 */
export async function openTelegramMedia(
  auth: TelegramAuth,
  chatId: string,
  messageId: number,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<{ meta: MediaMeta, body: ReadableStream<Uint8Array>, cap: number }> {
  const cap = Math.min(maxBytes, BRIDGE_MEDIA_MAX_BYTES)
  let opened: { headers: Headers, body: ReadableStream<Uint8Array> }
  try {
    opened = await createTelegramBridge(auth.telegram).media(chatId, messageId, cap, signal)
  }
  catch (error) {
    const status = httpStatusOf(error)
    const data = (error as { data?: { error?: unknown, size?: unknown } } | undefined)?.data
    const said = data?.error
    if (status === 413) {
      throw createError({
        statusCode: 413,
        message: typeof said === 'string' ? said : `This file is larger than the ${formatBytes(cap)} this connector fetches.`,
        // Telegram's reported size, when the bridge refused before sending.
        data: typeof data?.size === 'number' ? { size: data.size } : undefined,
      })
    }
    if (status === 502) {
      throw createError({ statusCode: 502, message: typeof said === 'string' ? said : 'Telegram returned no file for this message.' })
    }
    relayBridgeError(error, 'download the file')
  }

  const { headers, body } = opened
  const fileName = cleanFileName(decodeHeader(headers.get('x-media-file-name')))
  const size = Number(headers.get('x-media-size'))
  return {
    meta: {
      mediaType: headers.get('x-media-type') ?? 'document',
      mimeType: cleanMimeType(headers.get('content-type')),
      ...(fileName && { fileName }),
      ...(Number.isSafeInteger(size) && size >= 0 && { size }),
    },
    body,
    cap,
  }
}

/**
 * The whole file in memory, for an inline tool result: one media slot, the
 * stream read capped at `maxBytes` (413 the moment it passes it).
 */
export async function downloadTelegramMedia(
  auth: TelegramAuth,
  chatId: string,
  messageId: number,
  maxBytes: number,
): Promise<{ meta: MediaMeta, file: MediaFile }> {
  return await withMediaSlot(async () => {
    const { meta, body, cap } = await openTelegramMedia(auth, chatId, messageId, maxBytes, requestAbortSignal())
    const data = await readStreamCapped(body, cap, BRIDGE_CHUNK_BYTES)
    return {
      meta: { ...meta, size: data.length },
      file: { data, mimeType: meta.mimeType, ...(meta.fileName && { fileName: meta.fileName }) },
    }
  })
}

function decodeHeader(value: string | null): string | undefined {
  if (!value) return undefined
  try {
    return decodeURIComponent(value)
  }
  catch {
    return undefined
  }
}
