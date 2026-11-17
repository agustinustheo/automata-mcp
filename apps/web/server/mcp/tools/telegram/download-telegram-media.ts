import { z } from 'zod'

/**
 * Fetch the file a Telegram message carries, through the bridge. Never stored.
 * Same rules as `download-media` (WhatsApp): opt-in by name (never covered by
 * "All actions"), chat scope asserted before anything is fetched, small files
 * inline and larger ones by a signed URL only this token can follow.
 *
 * Telegram does not report a file's size in the synced row, so `auto` downloads
 * first and then decides; `url` skips the download and lets the link fetch it.
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
    + 'a `url` that works for ten minutes with this connection\'s Authorization header and no other. '
    + '`delivery` chooses: `auto` (default) inlines small files, `url` always returns a link, '
    + '`inline` never does. Self-destructing media is not downloadable, and the account must be '
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
    const signed = () => signMediaUrl({ k: 'telegram', i: auth.instance.id, t: auth.tokenId, c: chatId, m: String(messageId) })

    if (delivery === 'url') {
      const link = signed()
      if (!link) throw signedUrlUnavailable(undefined, inlineMax)
      return mediaUrlResult({ chatId, messageId, media: mediaKind }, link.url, link.expiresAt)
    }

    const { meta, file } = await downloadTelegramMedia(auth, chatId, messageId, mediaMaxBytes())
    const described = { chatId, messageId, ...meta }
    if (file.data.length <= inlineMax) return mediaInlineResult(described, file)

    if (delivery === 'inline') {
      throw createError({
        statusCode: 413,
        message: `This file is ${formatMediaBytes(file.data.length)}, over the ${formatMediaBytes(inlineMax)} returned inline. Call again with delivery: "url".`,
      })
    }
    const link = signed()
    if (!link) throw signedUrlUnavailable(file.data.length, inlineMax)
    return mediaUrlResult(described, link.url, link.expiresAt)
  },
})
