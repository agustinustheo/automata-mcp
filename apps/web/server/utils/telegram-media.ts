import type { McpAuth } from './mcp-auth'

type TelegramAuth = Extract<McpAuth, { kind: 'telegram' }>

/**
 * Telegram media for one message, through the bridge. Shared by the
 * `download-telegram-media` tool and the signed-URL route, so both run the same
 * checks. The caller asserts chat scope first (`assertChatAllowed`); the bridge
 * then fetches the message through that chat and refuses one from any other.
 */

/** The bridge's own ceiling on one download (`MEDIA_MAX_BYTES` in apps/telegram-bridge/src/http.ts). */
const BRIDGE_MEDIA_MAX_BYTES = 50 * 1024 * 1024

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
 * Download the file. The bridge refuses anything over `maxBytes` from the size
 * Telegram reports, before downloading, and aborts a download that passes it;
 * the answer is read through `fetchCappedJson` here as well. A 413 keeps the
 * bridge's own words, so a caller can tell "too large" from "bridge down".
 */
export async function downloadTelegramMedia(
  auth: TelegramAuth,
  chatId: string,
  messageId: number,
  maxBytes: number,
): Promise<{ meta: MediaMeta, file: MediaFile }> {
  const cap = Math.min(maxBytes, BRIDGE_MEDIA_MAX_BYTES)
  return await withMediaSlot(async () => {
    let answer: BridgeMedia
    try {
      answer = await createTelegramBridge(auth.telegram).media(chatId, messageId, cap)
    }
    catch (error) {
      const status = httpStatusOf(error)
      const said = (error as { data?: { error?: unknown } } | undefined)?.data?.error
      if (status === 413) {
        throw createError({ statusCode: 413, message: typeof said === 'string' ? said : `This file is larger than the ${formatBytes(cap)} this connector fetches.` })
      }
      if (status === 502) {
        throw createError({ statusCode: 502, message: typeof said === 'string' ? said : 'Telegram returned no file for this message.' })
      }
      relayBridgeError(error, 'download the file')
    }

    const data = Buffer.from(answer.data, 'base64')
    if (data.length > cap) {
      throw createError({
        statusCode: 413,
        message: `This file is ${formatBytes(data.length)}, larger than the ${formatBytes(cap)} this connector fetches.`,
      })
    }
    const mimeType = cleanMimeType(answer.mimeType)
    const fileName = cleanFileName(answer.fileName)
    return {
      meta: { mediaType: answer.mediaType, mimeType, ...(fileName && { fileName }), size: data.length },
      file: { data, mimeType, ...(fileName && { fileName }) },
    }
  })
}
