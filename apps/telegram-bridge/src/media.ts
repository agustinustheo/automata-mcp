import { Api } from 'teleproto'

/**
 * What a message's media is, before anything is downloaded: the kind callers
 * see, the type and name to hand back, and the size Telegram reports — so an
 * oversized file is refused without fetching it. Undefined for media with no
 * file to download (a location, a contact, a poll, a link preview) and for
 * self-destructing media, which the sender meant to be seen once.
 */
export interface MediaInfo {
  mediaType: 'photo' | 'video' | 'video-note' | 'audio' | 'voice' | 'sticker' | 'document'
  mimeType: string
  fileName?: string
  size?: number
}

export function mediaInfoOf(media: Api.TypeMessageMedia | undefined): MediaInfo | undefined {
  if (media instanceof Api.MessageMediaPhoto) {
    if (media.ttlSeconds || !(media.photo instanceof Api.Photo)) return undefined
    return { mediaType: 'photo', mimeType: 'image/jpeg', size: largestPhotoSize(media.photo) }
  }

  if (media instanceof Api.MessageMediaDocument) {
    if (media.ttlSeconds || !(media.document instanceof Api.Document)) return undefined
    const document = media.document
    let mediaType: MediaInfo['mediaType'] = 'document'
    let fileName: string | undefined
    for (const attribute of document.attributes) {
      if (attribute instanceof Api.DocumentAttributeFilename) fileName = attribute.fileName
      else if (attribute instanceof Api.DocumentAttributeSticker) mediaType = 'sticker'
      else if (attribute instanceof Api.DocumentAttributeAudio && mediaType === 'document') mediaType = attribute.voice ? 'voice' : 'audio'
      else if (attribute instanceof Api.DocumentAttributeVideo && mediaType === 'document') mediaType = attribute.roundMessage ? 'video-note' : 'video'
    }
    const size = Number(document.size.toString())
    return {
      mediaType,
      mimeType: document.mimeType || 'application/octet-stream',
      ...(fileName && { fileName }),
      ...(Number.isSafeInteger(size) && size >= 0 && { size }),
    }
  }

  return undefined
}

/** The size of the photo size teleproto downloads by default: the largest. */
function largestPhotoSize(photo: Api.Photo): number | undefined {
  let largest: number | undefined
  for (const size of photo.sizes) {
    const bytes = size instanceof Api.PhotoSize
      ? size.size
      : size instanceof Api.PhotoSizeProgressive
        ? Math.max(0, ...size.sizes)
        : undefined
    if (bytes !== undefined && (largest === undefined || bytes > largest)) largest = bytes
  }
  return largest
}
