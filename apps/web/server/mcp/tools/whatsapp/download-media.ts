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
 * **Returned in the result, up to `mediaInlineMaxBytes`**: images as images,
 * anything else as an embedded file, as `get-email-attachment` does. A larger
 * file is refused — by the sender's reported size without fetching, or
 * mid-stream when that size was missing or wrong.
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
    + 'as embedded files; a file larger than this connector returns is refused, with its size when '
    + 'known. View-once media is not downloadable. Old media may have expired on WhatsApp\'s '
    + 'servers; it can then be fetched only while the phone is online. Fetch only what the task '
    + 'needs: each call fetches the file again.',
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
  },
  handler: async ({ jid, messageId }) => {
    const auth = useMcpAuth()
    if (auth.kind !== 'whatsapp') throw createError({ statusCode: 401, statusMessage: 'Unauthorized' })

    const target = await findWhatsappMedia(auth, jid, messageId)
    const maxBytes = mediaInlineMaxBytes()
    const claimed = target.meta.size

    // Too large by the sender's own account: say so without fetching.
    if (claimed !== undefined && claimed > maxBytes) throw tooLarge(claimed, maxBytes)

    // The size is a claim, or missing: fetched capped, and a file over the cap
    // is refused (413) while it streams in.
    let file: MediaFile
    try {
      file = await downloadWhatsappMedia(auth, target, maxBytes)
    }
    catch (error) {
      // Over the cap by its bytes, whatever the sender claimed: no size quoted.
      if (httpStatusOf(error) === 413) throw tooLarge(undefined, maxBytes)
      throw error
    }
    const fetched = { jid, messageId, ...target.meta, mimeType: file.mimeType, size: file.data.length, ...(file.fileName && { fileName: file.fileName }) }
    return mediaInlineResult(fetched, file)
  },
})

function tooLarge(size: number | undefined, maxBytes: number) {
  return createError({
    statusCode: 413,
    message: `This file is ${size !== undefined ? `about ${formatBytes(size)}, ` : ''}larger than the ${formatBytes(maxBytes)} this connector returns.`,
  })
}
