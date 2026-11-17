import type { McpAuth } from '~~/server/utils/mcp-auth'
import type { MediaRef } from '~~/server/utils/media'

/**
 * Follow a signed media URL minted by `download-media` / `download-telegram-media`.
 *
 * MCP side of the auth split: the bearer token is required here exactly as on
 * `/mcp` (never a cookie — `isMcpPath` covers this prefix, so the session
 * middleware skips it and the path is redacted from logs), and it must be the
 * token the URL was minted for. Then every check the tool ran is run again —
 * the token may have been narrowed or revoked since: the opt-in tool still
 * granted, the per-minute budgets, the chat in scope, the message in that chat.
 * Only then is the file fetched, fresh; nothing was stored when the URL was made.
 *
 * Anything that does not match answers 404, saying no more about a URL than
 * that it leads nowhere — except an expired one, which says so (410), since
 * "call the tool again" is the useful answer and reveals nothing.
 */
export default defineEventHandler(async (event) => {
  const check = verifyMediaRef(getRouterParam(event, 'blob'))
  if (!check.ok) {
    throw createError(check.reason === 'expired'
      ? { statusCode: 410, statusMessage: 'This download link has expired. Call the download tool again for a new one.' }
      : { statusCode: 404, statusMessage: 'Not Found' })
  }
  const { ref } = check

  const auth = await resolveMcpAuth(event)
  if (!auth) return mcpUnauthorized()
  if (auth.tokenId !== ref.t || auth.instance.id !== ref.i || auth.kind !== ref.k) {
    throw createError({ statusCode: 404, statusMessage: 'Not Found' })
  }

  const refusal = await mcpLimitRefusal(auth.instance.org, auth.tokenId, auth.limits)
  if (refusal) return refusal

  event.context.mcpAuth = auth

  const tool = mediaToolFor(ref.k)
  if (!isToolAllowed(event, tool, ref.k)) {
    throw createError({ statusCode: 403, statusMessage: 'This connector token may no longer download media.' })
  }

  // Charged like one call of the tool: the token's and organization's
  // budgets, and the per-connection budget for costly tools.
  const throttled = await takeMcpBudget(chargesFor(auth, [{ name: tool, args: {} }]))
  if (throttled) return mcpRateLimited(throttled)

  // Counted and recorded like a call of the tool (name and outcome only), so a
  // followed link shows in usage and tool-call history too.
  const record = (ok: boolean) => {
    countToolCall(auth.instance.org, auth.tokenId, tool, ok)
    recordToolCall(auth, { tool, ok, reason: undefined, userAgent: getRequestHeader(event, 'user-agent') })
  }

  let served: ServedMedia
  try {
    served = await openMedia(auth, ref, record)
  }
  catch (error) {
    record(false)
    throw error
  }

  setResponseHeaders(event, {
    'content-type': served.mimeType,
    ...(served.length !== undefined && { 'content-length': served.length }),
    'content-disposition': attachmentDisposition(served.fileName),
    'cache-control': 'no-store, private',
    'x-content-type-options': 'nosniff',
    'content-security-policy': 'default-src \'none\'; sandbox',
    'referrer-policy': 'no-referrer',
  })
  return served.body
})

interface ServedMedia {
  mimeType: string
  fileName?: string
  /** Known only for a buffered file; a streamed one goes out chunked. */
  length?: number
  body: Buffer | ReadableStream<Uint8Array>
}

/**
 * The file a ref names, after the same scope checks the tool runs, fetched
 * fresh from its source. Telegram is streamed straight through from the bridge
 * (a media slot held until the stream ends; `record` called then). WhatsApp is
 * one bounded buffer: Evolution's only media route answers with the whole file
 * as base64 in a JSON body, so there is no stream to pass on.
 */
async function openMedia(auth: McpAuth, ref: MediaRef, record: (ok: boolean) => void): Promise<ServedMedia> {
  const maxBytes = mediaMaxBytes()
  switch (auth.kind) {
    case 'whatsapp': {
      const target = await findWhatsappMedia(auth, ref.c, ref.m)
      if (target.meta.size !== undefined && target.meta.size > maxBytes) {
        throw createError({ statusCode: 413, statusMessage: 'File larger than this connector fetches.' })
      }
      const file = await downloadWhatsappMedia(auth, target, maxBytes)
      record(true)
      return { mimeType: file.mimeType, fileName: file.fileName, length: file.data.length, body: file.data }
    }
    case 'telegram': {
      const messageId = Number(ref.m)
      assertChatAllowed(auth.scope, ref.c)
      await findTelegramMedia(auth, ref.c, messageId)
      const release = acquireMediaSlot()
      try {
        const { meta, body, cap } = await openTelegramMedia(auth, ref.c, messageId, maxBytes, requestAbortSignal())
        return {
          mimeType: meta.mimeType,
          fileName: meta.fileName,
          body: cappedPassThrough(body, cap, (ok) => {
            release()
            record(ok)
          }),
        }
      }
      catch (error) {
        release()
        throw error
      }
    }
    default:
      throw createError({ statusCode: 404, statusMessage: 'Not Found' })
  }
}
