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
  /** The media node itself, from that row. */
  media: WhatsappMediaNode
  meta: MediaMeta
}

/**
 * Resolve `messageId` in `jid` for this token, or refuse loudly: 403 for a chat
 * out of scope (from `expandChat`), 404 for no such message in that chat, 409
 * for an id another, unreadable chat also holds, 422 for a message with no
 * downloadable file or one that is view-once.
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

  // Fails closed: the same id in a chat this token cannot read means Evolution
  // (reforged reloads by id alone) might hand back that chat's file instead.
  if (await messageIdOutsideChats(auth.instance, chat.jids, messageId)) {
    throw createError({
      statusCode: 409,
      message: 'Another chat this connector token cannot read holds a message with the same id, so this file cannot be told apart safely and was not downloaded.',
    })
  }

  const { info, node } = whatsappMediaOf(row.message, row.messageType ?? undefined)
  if (!info || !node) {
    throw createError({
      statusCode: 422,
      message: node?.viewOnce || isViewOnceWrapped(row.message)
        ? 'This is a view-once message; its media is not downloadable here.'
        : 'This message carries no downloadable file (photo, video, voice note, audio, document or sticker).',
    })
  }

  return {
    jid,
    messageId,
    row,
    media: node,
    meta: {
      mediaType: info.mediaType,
      mimeType: info.mimetype ?? 'application/octet-stream',
      ...(info.fileName && { fileName: info.fileName }),
      ...(info.fileSize !== undefined && { size: info.fileSize }),
    },
  }
}

function isViewOnceWrapped(message: unknown): boolean {
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
 * The media node as Evolution should download it: this row's node alone, under
 * its own key, with a `url` kept only when it points at WhatsApp's media CDN.
 *
 * The stored payload is the sender's: on stock Evolution 2.3.7 a `url` in it is
 * fetched as given, so a crafted message could make Evolution request an
 * internal address. Without `url`, Baileys builds the address from
 * `directPath` on mmg.whatsapp.net. Sending the node alone also skips wrappers
 * (an album item's `associatedChildMessage`) Evolution would not unwrap.
 */
function downloadPayload(media: WhatsappMediaNode): Record<string, unknown> {
  const { url, ...rest } = media.node
  const safeUrl = typeof url === 'string' && /^https:\/\/[a-z0-9.-]+\.whatsapp\.net\//i.test(url) ? url : undefined
  return { [media.key]: { ...rest, ...(safeUrl && { url: safeUrl }) } }
}

/**
 * Download the file through Evolution's `getBase64FromMediaMessage`, which
 * decrypts it from WhatsApp's CDN (asking the phone to re-upload expired media).
 *
 * Evolution 2.3.7 downloads from the payload as sent (`downloadPayload`);
 * evolution-api-reforged ignores caller content on this route and reloads the
 * stored message by `key.id` alone, which is why `findWhatsappMedia` refuses an
 * id that also exists in a chat outside the token's scope.
 *
 * The answer is read through `fetchCappedJson`, so a file over `maxBytes` — the
 * sender's `fileLength` is only a claim — is cut off while it streams, before it
 * is parsed or decoded. One of this process's media slots is held throughout.
 */
export async function downloadWhatsappMedia(auth: WhatsappAuth, target: WhatsappMediaTarget, maxBytes: number): Promise<MediaFile> {
  return await withMediaSlot(async () => {
    const evolution = createEvolutionClient(auth.evolution)
    let answer: EvolutionMedia | null
    try {
      answer = await fetchCappedJson<EvolutionMedia | null>(
        evolution,
        `/chat/getBase64FromMediaMessage/${encodeURIComponent(auth.instance.name)}`,
        {
          method: 'POST',
          body: { message: { key: target.row.key, message: downloadPayload(target.media) }, convertToMp4: false },
          timeout: MEDIA_DOWNLOAD_DEADLINE_MS,
        },
        cappedBodyBytes(maxBytes),
      )
    }
    catch (error) {
      const status = httpStatusOf(error)
      if (status === 413) throw error
      console.error(`[media] WhatsApp download on connection ${auth.instance.id} failed: Evolution answered ${status ?? (error as Error | undefined)?.name ?? 'nothing'}`)
      const said = JSON.stringify((error as { data?: unknown } | undefined)?.data ?? '')
      if (status === 400 && /not of the media type/i.test(said)) {
        // evolution-api-reforged reloads the stored row and does not unwrap an
        // album item or an edit the way this app does; say what it is, not "expired".
        throw createError({
          statusCode: 422,
          message: 'This WhatsApp server cannot download this kind of message (an album item or an edited message). Its media is not reachable through this connector.',
        })
      }
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
        message: `This file is ${formatBytes(data.length)}, larger than the ${formatBytes(maxBytes)} this connector fetches.`,
      })
    }

    return {
      data,
      mimeType: cleanMimeType(answer.mimetype ?? target.meta.mimeType),
      fileName: target.meta.fileName ?? cleanFileName(answer.fileName),
    }
  })
}
