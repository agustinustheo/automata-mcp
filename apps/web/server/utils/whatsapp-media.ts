import type { McpAuth } from './mcp-auth'

type WhatsappAuth = Extract<McpAuth, { kind: 'whatsapp' }>

/**
 * WhatsApp media for one message: find it inside the token's chats, describe
 * it, and — when asked — download it through Evolution.
 *
 * One function serves the `download-media` tool and the signed-URL route, so
 * both run the same scope check against the same token on every fetch.
 */

export interface WhatsappMediaTarget {
  /** The chat as the caller named it. */
  jid: string
  messageId: string
  /** The message row, found inside the token's chats. */
  row: StoredMessage
  meta: MediaMeta
}

/**
 * Resolve `messageId` in `jid` for this token, or refuse loudly: 403 for a chat
 * out of scope (from `expandChat`), 404 for no such message in that chat, 422
 * for a message with no file or one that is view-once.
 */
export async function findWhatsappMedia(auth: WhatsappAuth, jid: string, messageId: string): Promise<WhatsappMediaTarget> {
  // Asserts `jid` first; adds the same person's other JID only if the token
  // reaches it too. A message is then looked up inside those chats only.
  const links = await lidLinks(auth.instance)
  const chat = expandChat(auth.scope, links, jid)

  const row = await findMessageInChats(auth.instance, chat.jids, messageId)
  if (!row) {
    throw createError({
      statusCode: 404,
      message: `No message with id ${messageId} in this chat. Pass a message id exactly as read-messages returned it, with the same jid.`,
    })
  }

  const media = whatsappMediaOf(row.message, row.messageType ?? undefined)
  if (!media) {
    throw createError({
      statusCode: 422,
      message: isViewOnce(row.message)
        ? 'This is a view-once message; its media is not downloadable here.'
        : 'This message carries no downloadable file (photo, video, voice note, audio, document or sticker).',
    })
  }

  return {
    jid,
    messageId,
    row,
    meta: {
      mediaType: media.mediaType,
      mimeType: media.mimetype ?? 'application/octet-stream',
      ...(media.fileName && { fileName: media.fileName }),
      ...(media.fileSize !== undefined && { size: media.fileSize }),
    },
  }
}

function isViewOnce(message: unknown): boolean {
  if (!message || typeof message !== 'object') return false
  return Object.keys(message).some(key => key.startsWith('viewOnceMessage'))
}

interface EvolutionMedia {
  mediaType?: string
  fileName?: string
  mimetype?: string
  base64?: string
}

/** Long enough for a large video through Evolution's own retry (it waits 5 s and tries again). */
const MEDIA_DOWNLOAD_DEADLINE_MS = 90_000

/**
 * Download the file through Evolution's `getBase64FromMediaMessage`, which
 * decrypts it from WhatsApp's CDN (asking the phone to re-upload expired media).
 *
 * The verified row goes in the body: Evolution 2.3.7 downloads from that
 * content as given; evolution-api-reforged ignores caller content on this route
 * and reloads the stored message by `key.id`, which its migration made unique
 * per account. Either way the message is the one `findWhatsappMedia` found
 * inside the token's chats.
 *
 * The size the payload claimed was checked before calling; the bytes are
 * checked again here, since a claim is only a claim.
 */
export async function downloadWhatsappMedia(auth: WhatsappAuth, target: WhatsappMediaTarget, maxBytes: number): Promise<MediaFile> {
  const evolution = createEvolutionClient(auth.evolution)
  let answer: EvolutionMedia | null
  try {
    answer = await evolution<EvolutionMedia | null>(
      `/chat/getBase64FromMediaMessage/${encodeURIComponent(auth.instance.name)}`,
      {
        method: 'POST',
        body: { message: { key: target.row.key, message: target.row.message }, convertToMp4: false },
        timeout: MEDIA_DOWNLOAD_DEADLINE_MS,
      },
    )
  }
  catch (error) {
    const status = httpStatusOf(error)
    console.error(`[media] WhatsApp download on connection ${auth.instance.id} failed: Evolution answered ${status ?? (error as Error | undefined)?.name ?? 'nothing'}`)
    if (status === 400) {
      throw createError({
        statusCode: 422,
        message: 'WhatsApp could not provide this file. Old media expires on WhatsApp\'s servers and can only be '
          + 're-fetched while the phone is online and still holds it; check get-connection-status and try again later.',
      })
    }
    throw createError({
      statusCode: 503,
      message: 'The WhatsApp server did not return the file. Check get-connection-status and try again.',
    })
  }

  if (!answer?.base64) {
    throw createError({ statusCode: 422, message: 'WhatsApp returned no file for this message.' })
  }

  const data = Buffer.from(answer.base64, 'base64')
  if (data.length > maxBytes) {
    throw createError({
      statusCode: 413,
      message: `This file is ${formatMediaBytes(data.length)}, larger than the ${formatMediaBytes(maxBytes)} this connector fetches.`,
    })
  }

  return {
    data,
    mimeType: cleanMimeType(answer.mimetype ?? target.meta.mimeType),
    fileName: target.meta.fileName ?? cleanFileName(answer.fileName),
  }
}
