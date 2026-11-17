import { z } from 'zod'

/**
 * Fetch the file a WhatsApp message carries. Never stored — not in the database,
 * not on disk — the same rule as IMAP attachments.
 *
 * **Opt-in.** Listed in `shared/opt-in-tools.ts`, so a token reaches it only
 * when it is ticked by name: "All actions" does not include it, and no token
 * minted before it existed gains it.
 *
 * **Scope is checked against the chat, then the message against the chat.**
 * `findWhatsappMedia` asserts `jid` and looks the message up inside the
 * token's chats only — Evolution's own media route would find any message of
 * the account by id.
 *
 * **Small files inline, larger ones by signed URL.** Up to `mediaInlineMaxBytes`
 * the bytes come back in the result (images as images, anything else as an
 * embedded file, as `get-email-attachment` does); above it, up to
 * `mediaMaxBytes`, a URL valid for ten minutes that only this token can follow,
 * which re-runs every check here before fetching. Above that, refused with the
 * size.
 */
export default defineKindTool({
  name: 'download-media',
  kind: 'whatsapp',
  title: 'Download WhatsApp media',
  description:
    'Download the file a WhatsApp message carries — a photo, video, voice note, audio file, '
    + 'document or sticker. Pass the chat `jid` and the message `id`, exactly as read-messages '
    + 'returned them; read-messages marks such messages with `hasMedia`, `mediaType`, `mimetype` '
    + 'and, when known, `fileName` and `fileSize`. Images come back as images and other files '
    + 'as embedded files, when small enough; a larger file comes back as a `url` that works for '
    + 'ten minutes with this connection\'s Authorization header and no other. `delivery` chooses: '
    + '`auto` (default) inlines small files, `url` always returns a link, `inline` never does. '
    + 'View-once media is not downloadable. Old media may have expired on WhatsApp\'s servers; '
    + 'it can then be fetched only while the phone is online. Fetch only what the task needs: '
    + 'each call downloads the file.',
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  expensive: true,
  inputSchema: {
    jid: z.string().min(1).max(200).describe('Chat identifier from list-chats or read-messages, exactly as returned'),
    messageId: z.string().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/, 'a WhatsApp message id').describe('The message `id` from read-messages'),
    delivery: z.enum(['auto', 'inline', 'url']).default('auto')
      .describe('auto: inline when small, else a signed URL. inline: never a URL. url: always a URL.'),
  },
  handler: async ({ jid, messageId, delivery }) => {
    const auth = useMcpAuth()
    if (auth.kind !== 'whatsapp') throw createError({ statusCode: 401, statusMessage: 'Unauthorized' })

    const target = await findWhatsappMedia(auth, jid, messageId)
    const maxBytes = mediaMaxBytes()
    const inlineMax = mediaInlineMaxBytes()
    const claimed = target.meta.size

    if (claimed !== undefined && claimed > maxBytes) {
      throw createError({
        statusCode: 413,
        message: `This file is about ${formatMediaBytes(claimed)}, larger than the ${formatMediaBytes(maxBytes)} this connector fetches.`,
      })
    }

    const meta = { jid, messageId, ...target.meta }
    const signed = () => signMediaUrl({ k: 'whatsapp', i: auth.instance.id, t: auth.tokenId, c: jid, m: messageId })

    // Known to be large, or the caller asked for a link: no download here — the
    // URL fetches it when followed.
    if (delivery === 'url' || (delivery === 'auto' && claimed !== undefined && claimed > inlineMax)) {
      const link = signed()
      if (!link) throw signedUrlUnavailable(claimed, inlineMax)
      return mediaUrlResult(meta, link.url, link.expiresAt)
    }

    const file = await downloadWhatsappMedia(auth, target, maxBytes)
    const fetched = { ...meta, mimeType: file.mimeType, size: file.data.length, ...(file.fileName && { fileName: file.fileName }) }
    if (file.data.length <= inlineMax) return mediaInlineResult(fetched, file)

    if (delivery === 'inline') {
      throw createError({
        statusCode: 413,
        message: `This file is ${formatMediaBytes(file.data.length)}, over the ${formatMediaBytes(inlineMax)} returned inline. Call again with delivery: "url".`,
      })
    }
    const link = signed()
    if (!link) throw signedUrlUnavailable(file.data.length, inlineMax)
    return mediaUrlResult(fetched, link.url, link.expiresAt)
  },
})
