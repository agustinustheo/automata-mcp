/**
 * Media a message carries: what its sender wrote about the file, reduced to
 * something safe to hand on. Every value is the sender's claim.
 */

/**
 * A MIME type safe to put in a tool result: anything a sender wrote that does
 * not look like `type/subtype` becomes octet-stream. This is syntax only —
 * `text/html` passes.
 */
export function cleanMimeType(raw: unknown): string {
  if (typeof raw !== 'string') return 'application/octet-stream'
  const base = raw.split(';')[0]!.trim().toLowerCase()
  return /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/.test(base)
    ? base
    : 'application/octet-stream'
}

/**
 * A sender-chosen file name, reduced to something that cannot carry a path or a
 * control character. Made well-formed and clipped by code point, never by UTF-16
 * unit: a split surrogate pair makes `encodeURIComponent` throw.
 */
export function cleanFileName(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const wellFormed = (raw as string & { toWellFormed(): string }).toWellFormed()
  // eslint-disable-next-line no-control-regex
  const name = Array.from(wellFormed.replace(/[\u0000-\u001f\u007f/\\]/g, '_').trim()).slice(0, 200).join('')
  return name && name !== '.' && name !== '..' ? name : undefined
}
