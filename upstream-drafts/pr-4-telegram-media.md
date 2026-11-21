# PR 4 of 4

- **Branch:** `agustinustheo:feat/media-4-telegram` → `ju-li:main`
- **Title:** Add download-telegram-media, streamed through the bridge
- **Stacked on PR 3.** This PR's own commits: https://github.com/agustinustheo/automata-mcp/compare/feat/media-3-signed-links...feat/media-4-telegram

---

## 📋 Description

This adds `download-telegram-media`, the Telegram twin of `download-media`. It's opt-in, read-only, and uses the same delivery: inline up to 5 MiB, otherwise a signed link (PR 3). Unlike WhatsApp, the file is **streamed end to end**. Nothing is written to disk or to the `telegram` schema.

There are three commits.

**1. Bridge: `GET /sessions/:id/media`** (`apps/telegram-bridge/src/media.ts`, `http.ts`, `sessions.ts`)

- **Format.** The answer is raw bytes, chunk by chunk (`iterDownload`), with metadata in `x-media-*` headers.
- **Chat check.** The message is fetched **through the chat's peer** and refused unless `markedId(peerId)` is that chat. Private chats and basic groups share one message-id counter per account, so an id alone could name a message elsewhere. Self-destructing media (`ttlSeconds`) is refused.
- **Size.** The size comes from `Document.size`, or from the last `PhotoSize`, which is what teleproto downloads. It is checked before downloading and again on the bytes, and enforced both ways per chunk, so a stream that ends short or runs long fails with a 502 instead of looking whole. There's a 50 MiB ceiling whatever the app asks for.
- **Limits.** Each download has a 120 s deadline and aborts when the app disconnects. At most 2 run at once, 1 per session.
- **Cut-off requests.** teleproto gives a chunk request no timeout and checks its signal only between chunks. So a cut-off download stops *waiting* at once, but the abandoned request keeps its place in the limit until it settles, **never on a timer**: a timed release let repeated cancels pile up live requests.
  - At 10 minutes the session's client is torn down: `reconnect` first, then `disconnect()` on the captured client, each bounded. That rejects the pending request and frees the place.
  - Still pending a minute after teardown → error log, place kept (fail closed).

**2. App: the tool** (`telegram-media.ts`, the tool, `telegram.ts`, `telegram-db.ts`, plus the Telegram branches in `media.ts` and the link route)

- **Checks before asking the bridge.** `assertChatAllowed` checks scope, and the synced `telegram.messages` row must exist in that chat.
- **Link route.** A link pipes the bridge's stream straight to the caller with the same capped, paced `pipeMediaToResponse` as WhatsApp, under a 90 s end-to-end deadline on the bridge request.
- **Inline.** Only an inline result is read into memory, capped (`readStreamCapped`), with its length checked again.
- **Opt-in list.** `download-telegram-media` joins `shared/opt-in-tools.ts`.

**3. Docs:** `docs/telegram.md` "Downloading media", README, `CLAUDE.md`, `docs/using-automata.md`, `docs/self-hosting.md`.

## 🔗 Related Issue

Part of #266 (4 of 4). Builds on PR 3.

## 🧪 Type of Change

- [ ] 🐛 Bug fix (non-breaking change which fixes an issue)
- [x] ✨ New feature (non-breaking change which adds functionality)
- [ ] 💥 Breaking change (fix or feature that would cause existing functionality to not work as expected)
- [x] 📚 Documentation update
- [ ] 🔧 Refactoring (no functional changes)
- [ ] ⚡ Performance improvement
- [ ] 🧹 Code cleanup
- [ ] 🔒 Security fix

## 🧪 Testing

- [x] Manual testing completed
- [x] Functionality verified in development environment (app side and the bridge route's checks; see notes)
- [x] No breaking changes introduced
- [x] Tested with different connection types (if applicable)
- [x] `pnpm typecheck` passes
- [x] `pnpm bridge:typecheck` passes (if `apps/telegram-bridge` changed)
- [x] `pnpm cloud:typecheck` passes (if `apps/cloud` changed)
- [x] `pnpm test:emails` passes (if account emails changed)
- [x] `pnpm listings:check` passes (if MCP tools or the version changed): 24 tools

### Test plan (dev stack, no external server)

**Setup**

1. Set `TELEGRAM_API_ID` / `TELEGRAM_API_HASH` in `.env`, then run `pnpm services:up:telegram` and `pnpm dev`.
2. Create a Telegram connection and link a test account by QR.
3. In one chat (`CHAT`), send a photo, a small document and a document over 5 MiB. Wait for sync (`get-telegram-status`).
4. Mint three tokens:
   - `TG_A`, scoped to `CHAT`, with *Media downloads → Download Telegram media* ticked;
   - `TG_B`, scoped to another chat, also ticked;
   - `TG_ALL`, on All chats and All actions with media downloads unticked.

Use the `mcp` / `call` / `get` helpers from PR 3.

```bash
call "$TG_A" read-telegram-messages "{\"chatId\":\"$CHAT\",\"limit\":20}" | jq -r '.result.content[0].text | fromjson | .messages[] | select(.media) | "\(.id) \(.media)"'
tg() { call "$1" download-telegram-media "{\"chatId\":\"$2\",\"messageId\":$3${4:+,\"delivery\":\"$4\"}}"; }
```

**1. Inline and link give the same bytes.**

```bash
tg "$TG_A" "$CHAT" $PHOTO | jq -r '.result.content[1].type'                          # → image
tg "$TG_A" "$CHAT" $PHOTO inline | jq -r '.result.content[1].data' | base64 -d > a.jpg
U=$(tg "$TG_A" "$CHAT" $PHOTO url | jq -r '.result.content[0].text | fromjson | .url')
get "$U" "$TG_A" b.jpg; shasum -a 256 a.jpg b.jpg                                    # → 200, same hash
tg "$TG_A" "$CHAT" $BIGDOC | jq -r '.result.content[0].text | fromjson | .delivery'   # → url
```

**2. Scope and tokens.**

```bash
tg "$TG_B" "$CHAT" $PHOTO | jq -r '.result.content[0].text'   # → [403] This connector token is not scoped to …
get "$U"; get "$U" "$TG_B"                                    # → 401, 404
mcp "$TG_ALL" '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | jq -r '.result.tools[].name' | grep -c download-telegram-media   # all-actions token → 0
```

**3. Cut-off downloads hold their place, then free it.**

```bash
for i in 1 2 3 4 5; do curl -s --max-time 2 --limit-rate 1k -o /dev/null -H "Authorization: Bearer $TG_A" "$U"; done
sleep 3; get "$U" "$TG_A"   # → 200 (immediately, or after a short 429 while the last cut-off request settles)
```

An account that isn't linked: with `TELEGRAM_API_ID` / `TELEGRAM_API_HASH` set and no linked session, any download answers 409 "This session is not connected to Telegram right now."

**4. Two at once.**

```bash
U2=$(tg "$TG_A" "$CHAT" $BIGDOC url | jq -r '.result.content[0].text | fromjson | .url')
curl -s --limit-rate 200k -o /dev/null -H "Authorization: Bearer $TG_A" "$U2" & sleep 2
get "$U" "$TG_A"; wait      # → 429 while the first runs
```

**5. A broken stream is never a whole file** (needs a linked account; on the dev stack this was checked with a stub stream that ended short). Start `curl --limit-rate 50k -o x.bin -H "Authorization: Bearer $TG_A" "$U2"`, then run `docker compose -f docker-compose.dev.yml restart telegram-bridge`. curl ends with error 18 (partial transfer), not a short file reported complete.

## 📸 Screenshots (if applicable)

Not applicable. The token dialog block is the same as in PR 2, now listing the Telegram tool.

## ✅ Checklist

- [x] My changes follow the rules in `CLAUDE.md`
- [x] I have performed a self-review of my code
- [x] I have commented my code, particularly in hard-to-understand areas
- [x] I have made corresponding changes to the documentation
- [x] My changes generate no new warnings
- [x] I have manually tested my changes thoroughly
- [x] I have verified the changes work with different scenarios
- [ ] Any dependent changes have been merged and published (PR 3)

## 📝 Additional Notes

- **How it was tested, on the dev stack.** No Telegram account was linked to the dev stack. So the bridge was this branch's real bridge, running on the host, behind a small local stub. The stub answered only `GET /sessions/:id/media` from local files, in the bridge's format, and could fail on purpose. The session, chats and messages were synthetic rows.
  - **Through the app, all as expected:**
    - Opt-in: an all-actions token doesn't list or reach the tool.
    - `read-telegram-messages` reports `media`.
    - The inline photo, and a PDF with a UTF-8 file name, match their source SHA-256.
    - A 6 MiB video, sized or unsized, comes back as a link that matches its source SHA-256, with an exact `Content-Length`.
    - Text: 422. A message synced only in another chat: 404. Another chat's token: 403.
    - Links: no token or unknown token 401; other tokens, Telegram or WhatsApp, 404.
  - **A bridge stream that ends 100 KB short:**
    - Link: 5,783,552 of 6,291,456 bytes and curl error 18. Never complete.
    - Inline: 502 "The download broke off…".
  - **Bridge errors relayed:** 413 (with size), 502, 429, 404, and 422 (self-destructing).
  - **Concurrency.** A second download or link while a link streams: 429. After a hang-up, and after five cut-off links: 200.
  - **The real bridge's route.**
    - No key, wrong key or unknown session: 401. POST: 405.
    - With dummy API credentials (and no linked session, so nothing contacts Telegram): bad `chatId`, missing or negative `messageId`, or `maxBytes` of 0 or non-numeric each get 400 with a specific reason.
    - An unlinked session gets 409, and the app relays it.
  - **WhatsApp regression.** PR 2's inline suite and a WhatsApp link both pass on this branch.
  - **Not run on the dev stack: the bridge's actual download from Telegram.** These need a linked account: `iterDownload`, the peer check, the exact-size checks against Telegram's sizes, self-destructing detection, and the hold-until-settled and 10-minute teardown. Plan items 3 and 5 depend on them too.
- **In production.** Apart from one wording fix in a 501 message, this branch's code is what has run in production. Telegram photos were tested there inline and by link, with five cut-off streams followed by a successful download, and bridge restarts stayed at 0.
- **teleproto bumps.** Re-check `iterDownload`: there is no per-request timeout, and the signal is only checked between chunks. Also re-check `getFileInfo`: the photo is the last `sizes` entry, which the exact-size check relies on. `CLAUDE.md` notes both.
- **Sizes.** `MEDIA_MAX_BYTES` in the bridge (`http.ts`) and `BRIDGE_MEDIA_MAX_BYTES` in the app (`telegram-media.ts`) must change together.
