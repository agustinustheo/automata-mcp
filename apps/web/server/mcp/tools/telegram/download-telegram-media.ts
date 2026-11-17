import { z } from 'zod'

/**
 * Fetch the file a Telegram message carries, through the bridge. Never stored.
 * Same rules as `download-media` (WhatsApp): opt-in by name (never covered by
 * "All actions"), chat scope asserted before anything is fetched, small files
 * inline and larger ones by a signed URL only this token can follow.
 *
 * Telegram does not report a file's size in the synced row, so `auto` first
 * asks the bridge for the file capped at the inline limit: the bridge refuses
 * a larger one from Telegram's reported size before downloading (413), and the
 * answer is then a link, which fetches the file once, when followed.
 */
export default defineKindTool({
  name: 'download-telegram-media',
  kind: 'telegram',
  title: 'Download Telegram media',
  description:
    'Download the file a Telegram message carries — a photo, video, video note, voice message, '
    + 'audio file, sticker or document. Pass the `chatId` and the message `id` exactly as '
    + 'read-telegram-messages returned them; messages with a file carry `media`. Images come back '
    + 'as images and other files as embedded files, when small enough; a larger file comes back as '
    + 'a `url` that works for ten minutes when fetched with this connection\'s Authorization header, '
    + 'and only for this token (a client that puts the token in the URL path cannot follow it: use '
    + '`inline`). `delivery` chooses: `auto` (default) inlines small files, `url` always returns a '
    + 'link, `inline` never does. Self-destructing media is not downloadable, and the account must be '
    + 'online (get-telegram-status). Fetch only what the task needs: each call downloads the file.',
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  expensive: true,
  inputSchema: {
    chatId: z.string().regex(/^-?\d{1,20}$/, 'a chat id written as a string of digits')
      .describe('Chat id from list-telegram-chats or read-telegram-messages, as a string'),
    messageId: z.number().int().positive().max(2 ** 31 - 1).describe('The message `id` from read-telegram-messages'),
    delivery: z.enum(['auto', 'inline', 'url']).default('auto')
      .describe('auto: inline when small, else a signed URL. inline: never a URL. url: always a URL.'),
  },
  handler: async ({ chatId, messageId, delivery }) => {
    const auth = useMcpAuth()
    if (auth.kind !== 'telegram') throw createError({ statusCode: 401, statusMessage: 'Unauthorized' })

    assertChatAllowed(auth.scope, chatId)
    const mediaKind = await findTelegramMedia(auth, chatId, messageId)
    const inlineMax = mediaInlineMaxBytes()
    const link = () => {
      const signed = signMediaUrl({ k: 'telegram', i: auth.instance.id, t: auth.tokenId, c: chatId, m: String(messageId) })
      if (!signed) throw signedUrlUnavailable(undefined, inlineMax)
      return mediaUrlResult({ chatId, messageId, media: mediaKind }, signed.url, signed.expiresAt)
    }

    if (delivery === 'url') return link()

    try {
      const { meta, file } = await downloadTelegramMedia(auth, chatId, messageId, inlineMax)
      return mediaInlineResult({ chatId, messageId, ...meta }, file)
    }
    catch (error) {
      if (httpStatusOf(error) !== 413) throw error
      if (delivery === 'inline') {
        throw createError({
          statusCode: 413,
          message: `This file is over the ${formatBytes(inlineMax)} returned inline. Call again with delivery: "url".`,
        })
      }
      return link()
    }
  },
})
