import type { McpAuth } from './mcp-auth'

type TelegramAuth = Extract<McpAuth, { kind: 'telegram' }>

/**
 * Telegram media for one message, through the bridge. Shared by the
 * `download-telegram-media` tool and the signed-URL route, so both run the same
 * checks. The caller asserts chat scope first (`assertChatAllowed`); the bridge
 * then fetches the message through that chat and refuses one from any other.
 */

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

/** Download the file. The bridge enforces `maxBytes` before and after downloading. */
export async function downloadTelegramMedia(
  auth: TelegramAuth,
  chatId: string,
  messageId: number,
  maxBytes: number,
): Promise<{ meta: MediaMeta, file: MediaFile }> {
  let answer: BridgeMedia
  try {
    answer = await createTelegramBridge(auth.telegram).media(chatId, messageId, maxBytes)
  }
  catch (error) {
    relayBridgeError(error, 'download the file')
  }

  const data = Buffer.from(answer.data, 'base64')
  if (data.length > maxBytes) {
    throw createError({
      statusCode: 413,
      message: `This file is ${formatMediaBytes(data.length)}, larger than the ${formatMediaBytes(maxBytes)} this connector fetches.`,
    })
  }
  const mimeType = cleanMimeType(answer.mimeType)
  const fileName = cleanFileName(answer.fileName)
  return {
    meta: { mediaType: answer.mediaType, mimeType, ...(fileName && { fileName }), size: data.length },
    file: { data, mimeType, ...(fileName && { fileName }) },
  }
}
