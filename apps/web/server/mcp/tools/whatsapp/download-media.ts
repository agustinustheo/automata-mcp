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
 * size. A size the sender did not give is found out by fetching capped at the
 * inline limit, so a large file is never downloaded twice.
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
    + 'ten minutes when fetched with this connection\'s Authorization header, and only for this '
    + 'token (a client that puts the token in the URL path cannot follow it: use `inline`). '
    + '`delivery` chooses: `auto` (default) inlines small files, `url` always returns a link, '
    + '`inline` never does. View-once media is not downloadable. Old media may have expired on '
    + 'WhatsApp\'s servers; it can then be fetched only while the phone is online. Fetch only what '
    + 'the task needs: each call downloads the file.',
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
        message: `This file is about ${formatBytes(claimed)}, larger than the ${formatBytes(maxBytes)} this connector fetches.`,
      })
    }

    const meta = { jid, messageId, ...target.meta }
    const link = (described: Record<string, unknown>, size: number | undefined) => {
      const signed = signMediaUrl({ k: 'whatsapp', i: auth.instance.id, t: auth.tokenId, c: jid, m: messageId })
      if (!signed) throw signedUrlUnavailable(size, inlineMax)
      return mediaUrlResult(described, signed.url, signed.expiresAt)
    }

    // Known to be large, or the caller asked for a link: no download here — the
    // URL fetches it when followed.
    if (delivery === 'url' || (delivery === 'auto' && claimed !== undefined && claimed > inlineMax)) {
      return link(meta, claimed)
    }

    // The size is a claim, or missing: fetch capped at the inline limit. A file
    // over it is refused (413) mid-stream; `auto` then answers with a link rather
    // than downloading it whole here and again when the link is followed.
    let file: MediaFile
    try {
      file = await downloadWhatsappMedia(auth, target, inlineMax)
    }
    catch (error) {
      if (httpStatusOf(error) !== 413 || delivery === 'inline') throw error
      return link(meta, claimed)
    }
    const fetched = { ...meta, mimeType: file.mimeType, size: file.data.length, ...(file.fileName && { fileName: file.fileName }) }
    return mediaInlineResult(fetched, file)
  },
})
