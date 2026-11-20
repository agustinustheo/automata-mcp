import type { AppInstance } from './app-db'
import type { SentMessageRef } from './evolution-db'
import { rememberBounded } from './lookup-cache'

/**
 * Whether WhatsApp acknowledged a message this app sent — the send half of the
 * dead-socket evidence (socket-evidence.ts, #239).
 *
 * **Why a 200 proves nothing.** `/message/sendText` answers 200 once Evolution
 * has handed the message to Baileys and stored its row as `PENDING`. WhatsApp's
 * server ack arrives later as a `messages.update`, which Evolution processes on
 * the account's serial event queue and writes into `"Message".status`
 * (`SERVER_ACK`, then `DELIVERY_ACK`, `READ`, `PLAYED`). On an account whose
 * receive side is wedged that queue never gets there: sends keep answering 200
 * and their rows stay `PENDING` for good. Production, Nov 15: an account stopped
 * receiving at 23:15 UTC, its send at 01:01 answered 200 and was still
 * `PENDING` hours later — and that 200 had *cleared* the evidence #205 relies on.
 *
 * So the send no longer clears anything. Instead, `ACK_CHECK_DELAY_MS` after a
 * send this reads the row's status once — `"Message".status`, and for a row
 * still `PENDING` its receipts in `"MessageUpdate"`, since Evolution often
 * records the ack there without moving the row (`readSentMessageStatus`; the
 * row alone raised false alarms on healthy accounts, Nov 19):
 *
 *   - **Past `PENDING`** — proof the socket worked: the miss run ends and
 *     evidence from before the send is cleared (`noteSocketAcknowledged`).
 *   - **Still `PENDING`** — a miss. **Two in a row** with no ack between record
 *     the socket dead (`noteSocketDead`, at the *later* send's time). Never one:
 *     a single stray `PENDING` happens on healthy accounts (1 of 2, 6 of 26 API
 *     sends in a day in production), while wedged ones had every send of the
 *     day pending.
 *   - **No row, any other status, or the read failed** — nothing; not knowing
 *     is not a miss.
 *
 * Rules easy to undo:
 *
 *   - **The evidence is dated by the send, not the check.** `socketStalled`
 *     spends evidence older than Evolution's last reopen, and stock accounts
 *     reopen about every 50 minutes. A miss made after the last reopen must
 *     count, however early the run began — hence the later send's time, not the
 *     first miss's; and a send made before a reopen must not, hence not the
 *     check's time either.
 *   - **Only with a message database** (`canReadMessages`). Without one the
 *     send gives neither signal — same as `socketStalled`, which never reports
 *     a connection without one as stalled.
 *   - **In-process and best effort.** The run of misses and the pending checks
 *     live in this process; a restart or a send through another replica only
 *     delays detection. Timers are `unref`'d, capped in number, and never throw
 *     into anything — the send already answered.
 */

/** How long after a send its ack is looked for. WhatsApp's server ack normally takes well under a second. */
export const ACK_CHECK_DELAY_MS = 2 * 60_000

/** Misses in a row, with no ack between, that record the socket dead. */
const MISSES_TO_RECORD = 2

/** Statuses that prove WhatsApp received the message — `status[update.status]` in Evolution. */
const ACKED = new Set(['SERVER_ACK', 'DELIVERY_ACK', 'READ', 'PLAYED'])

/** Checks waiting on their timer, all connections together. Past it, new sends go unchecked. */
const MAX_PENDING_CHECKS = 2_000
let pendingChecks = 0

/** Per connection: misses in a row since the last ack. */
const missRuns = new Map<string, number>()
const MAX_MISS_RUNS = 10_000

/**
 * What `/message/sendText` answered, as the reference the check needs — or
 * `undefined` when the answer lacks it (nothing to look up, so no check).
 */
export function sentMessageRef(result: Record<string, unknown>): SentMessageRef | undefined {
  const key = result.key as { id?: unknown, remoteJid?: unknown } | undefined
  const id = typeof key?.id === 'string' && key.id ? key.id : undefined
  const remoteJid = typeof key?.remoteJid === 'string' && key.remoteJid ? key.remoteJid : undefined
  const timestamp = Number(result.messageTimestamp)
  if (!id || !remoteJid || !Number.isFinite(timestamp) || timestamp <= 0) return undefined
  return { id, remoteJid, timestamp: Math.floor(timestamp) }
}

/**
 * Look for the ack of a message just sent, `ACK_CHECK_DELAY_MS` from now.
 * Fire and forget.
 */
export function watchSendAck(instance: AppInstance, result: Record<string, unknown>): void {
  if (!canReadMessages(instance)) return
  const sent = sentMessageRef(result)
  if (!sent) return
  if (pendingChecks >= MAX_PENDING_CHECKS) return

  const sentAt = new Date()
  pendingChecks += 1
  setTimeout(() => {
    pendingChecks -= 1
    checkSendAck(instance, sent, sentAt).catch((error) => {
      console.error(`[socket] connection ${instance.id}: could not check the ack of a send:`, error)
    })
  }, ACK_CHECK_DELAY_MS).unref?.()
}

async function checkSendAck(instance: AppInstance, sent: SentMessageRef, sentAt: Date): Promise<void> {
  let status: string | undefined
  try {
    status = await readSentMessageStatus(instance, sent)
  }
  catch (error) {
    // Unknown, not a miss. The message database's own faults are reported by
    // the reads that depend on it; one line here is enough.
    console.warn(`[socket] connection ${instance.id}: could not read the status of a sent message:`, (error as Error)?.message ?? error)
    return
  }

  const verdict = judgeAck(status)
  if (verdict === 'acked') {
    missRuns.delete(instance.id)
    noteSocketAcknowledged(instance.id, sentAt)
    return
  }
  if (verdict !== 'missed') return

  const misses = (missRuns.get(instance.id) ?? 0) + 1
  rememberBounded(missRuns, instance.id, misses, MAX_MISS_RUNS)
  if (misses < MISSES_TO_RECORD) {
    console.info(`[socket] connection ${instance.id}: a send is still PENDING ${ACK_CHECK_DELAY_MS / 1000} s on (${misses} in a row)`)
    return
  }
  noteSocketDead(instance, `send left unacknowledged (${misses} in a row)`, sentAt)
}

/** What one stored status says about the socket. Pure. */
export function judgeAck(status: string | undefined): 'acked' | 'missed' | 'unknown' {
  if (status === 'PENDING') return 'missed'
  if (status && ACKED.has(status)) return 'acked'
  return 'unknown'
}
