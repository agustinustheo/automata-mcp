import { isIP } from 'node:net'
import type { IncomingMessage } from 'node:http'
import { z } from 'zod'
import type { Crm } from './crm.ts'
import { BrevoError } from './crm.ts'
import type { Sql } from './db.ts'
import { HttpError, describeError } from './http-error.ts'

/**
 * Update mail for self-hosters: breaking changes and security advisories, and
 * nothing else. A self-hosted install's onboarding offers it; the install's
 * server posts the address here (`POST /self-host/updates`, public — a
 * self-hosted install holds no key of ours). Stored in
 * `cloud.self_host_subscribers`, then added to the Brevo list
 * `BREVO_SELF_HOST_LIST` through crm.ts.
 *
 * Rules that hold it up:
 *
 * - **Public, so throttled.** Per caller address and in total, in memory — a
 *   speed bump, like the web app's invite-mail throttle. One replica's view.
 * - **The answer never says whether the address was already here.**
 * - **Storing is the promise; the list is a copy.** A failed Brevo call leaves
 *   the row unsynced and `syncPending` retries it, so an address taken is never
 *   lost to an outage.
 * - **Never logged:** the address or the caller's IP.
 */

const PER_CALLER_PER_HOUR = 5
const TOTAL_PER_HOUR = 300
const HOUR_MS = 60 * 60_000
/** Rows synced per pass. */
const SYNC_BATCH = 50

const body = z.object({
  email: z.string().trim().email().max(320),
  // The install's version, from its root package.json. Free text from a public
  // caller, so shape-checked and short.
  version: z.string().regex(/^[0-9A-Za-z.+-]{1,32}$/).optional(),
})

export class SelfHostUpdates {
  private readonly callers = new Map<string, { count: number, resetAt: number }>()
  private total = { count: 0, resetAt: 0 }

  private readonly sql: Sql
  private readonly crm: Crm
  private readonly listId: number | undefined

  constructor(sql: Sql, crm: Crm, listId: number | undefined) {
    this.sql = sql
    this.crm = crm
    this.listId = listId
  }

  /** Whether stored addresses reach a Brevo list. Reported on /health. */
  get status(): 'stored-only' | 'syncing' {
    return this.crm.configured && this.listId !== undefined ? 'syncing' : 'stored-only'
  }

  /** `POST /self-host/updates`. Throws `HttpError` for the caller. */
  async subscribe(input: unknown, req: IncomingMessage): Promise<void> {
    const parsed = body.safeParse(input)
    if (!parsed.success) throw new HttpError(400, 'Enter a valid email address.')
    this.claim(callerOf(req))

    const email = parsed.data.email.toLowerCase()
    const [row] = await this.sql<{ synced_at?: string, refused_at?: string }[]>`
      INSERT INTO cloud.self_host_subscribers (email, version)
      VALUES (${email}, ${parsed.data.version ?? null})
      ON CONFLICT (email) DO UPDATE SET version = COALESCE(EXCLUDED.version, cloud.self_host_subscribers.version), updated = now()
      RETURNING synced_at, refused_at
    `
    if (row?.synced_at || row?.refused_at) return
    // Best effort now; syncPending is the retry. Not awaited past a failure.
    await this.sync(email).catch(error => console.warn(`[self-host] list sync deferred: ${describeError(error)}`))
  }

  /** Put every stored, unsynced address on the list. Run on a timer. */
  async syncPending(): Promise<void> {
    if (this.status !== 'syncing') return
    const rows = await this.sql<{ email: string }[]>`
      SELECT email FROM cloud.self_host_subscribers WHERE synced_at IS NULL AND refused_at IS NULL ORDER BY created LIMIT ${SYNC_BATCH}
    `
    let synced = 0
    for (const { email } of rows) {
      try {
        await this.sync(email)
        synced++
      }
      catch (error) {
        // Brevo down, or the key refused: stop the pass, the next one retries.
        if (!(error instanceof BrevoError) || error.kind !== 'permanent') throw error
        // An address Brevo calls invalid stays stored and unsynced; logged by
        // status alone, as crm.ts logs contact failures.
        console.warn(`[self-host] Brevo refused a subscriber: ${error.status}${error.code ? ` (${error.code})` : ''}`)
        await this.sql`UPDATE cloud.self_host_subscribers SET refused_at = now() WHERE email = ${email}`
      }
    }
    if (synced) console.info(`[self-host] added ${synced} subscriber(s) to the Brevo list`)
  }

  private async sync(email: string): Promise<void> {
    if (this.status !== 'syncing') return
    await this.crm.addToList(email, this.listId!)
    await this.sql`UPDATE cloud.self_host_subscribers SET synced_at = now() WHERE email = ${email}`
  }

  private claim(caller: string): void {
    const now = Date.now()
    if (now >= this.total.resetAt) this.total = { count: 0, resetAt: now + HOUR_MS }
    const mine = this.callers.get(caller)
    const current = mine && now < mine.resetAt ? mine : { count: 0, resetAt: now + HOUR_MS }
    if (current.count >= PER_CALLER_PER_HOUR || this.total.count >= TOTAL_PER_HOUR) {
      throw new HttpError(429, 'Too many signups right now. Try again later.')
    }
    current.count++
    this.total.count++
    this.callers.set(caller, current)
    if (this.callers.size > 10_000) {
      for (const [key, value] of this.callers) if (now >= value.resetAt) this.callers.delete(key)
    }
  }
}

/**
 * Who is calling, for the throttle only. Behind Railway's proxy the socket is
 * the proxy, which appends the real address as the last `X-Forwarded-For`
 * entry; anything before it is the caller's own claim.
 */
function callerOf(req: IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-for']
  const last = (Array.isArray(forwarded) ? forwarded.join(',') : forwarded ?? '').split(',').map(part => part.trim()).filter(Boolean).at(-1)
  if (last && isIP(last)) return last
  return req.socket.remoteAddress ?? 'unknown'
}
