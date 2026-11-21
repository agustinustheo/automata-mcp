# PR 2 of 4

- **Branch:** `agustinustheo:feat/media-2-whatsapp-download` → `ju-li:main`
- **Title:** Add download-media for WhatsApp, returned inline
- **Stacked on PR 1.** Until that merges, the diff includes its 2 commits. This PR's own commits: https://github.com/agustinustheo/automata-mcp/compare/feat/media-1-read-fields...feat/media-2-whatsapp-download

---

## 📋 Description

This adds the `download-media` tool for WhatsApp. It's opt-in and read-only, and returns the file a message carries **inside the tool result**, up to `NUXT_MEDIA_INLINE_MAX_BYTES` (5 MiB). Images come back as MCP images, anything else as an embedded resource, as `get-email-attachment` does. Larger files are refused here; PR 3 adds download links for them. Nothing is stored.

It has four commits:

1. **Opt-in tools that "All actions" doesn't cover** (`shared/opt-in-tools.ts`).
   - "All actions" means every tool a build ships, including future ones. Downloading files is a different class of data from reading text, so an existing all-actions token mustn't start doing it because the server was upgraded.
   - `isToolAllowed` grants an opt-in tool only by name. `scopeFromInput` and `scopeFields` keep opt-in names under `all_tools`, and only those.
   - The token dialog shows a separate "Media downloads" block in both modes, and the read-only preset never ticks it.
   - The token list stops saying "Full access" when media downloads are left out ("All chats · all actions except media downloads").
2. **A streaming base64 field reader** (`base64-field.ts`, no imports). Evolution's `getBase64FromMediaMessage` answers with the whole file as base64 in one JSON body. The reader decodes that field as the bytes arrive, so the file is held once instead of four times (body, text, base64 string, decoded). It refuses malformed or unpadded base64 and a repeated field.
3. **The tool** (`whatsapp-media.ts`, `media.ts`, `evolution-db.ts`, the tool file, config, listings).
4. **Docs.**

### Security and resource rules (each one is a comment in the code and a bullet under "Media downloads" in `CLAUDE.md`)

- **Scope in SQL.** `expandChat` checks the chat, then `findMessageInChats` looks the id up with `remoteJid = ANY(jids)`. Evolution's route finds a message by `key.id` account-wide, so without this a token scoped to one chat could fetch another chat's photo.
- **Repeated ids.** WhatsApp message ids are chosen by the sending device. evolution-api-reforged (the engine `main` pins) ignores the row we send and reloads by `key.id` alone. So wherever an index on `("instanceId", key->>'id')` exists, an id that another distinct message of the account shares is refused (409). The check is a boolean `EXISTS`, run before and again after Evolution answers.
  - Without the index the tool answers **501** unless Evolution's `GET /` reports 2.x. Stock 2.3.7 downloads from the row we send, so there it's safe. It never scans the account instead.
  - The `CREATE INDEX` line is in `docs/whatsapp.md`, next to the other indexes on Evolution's tables.
- **SSRF.** On 2.3.7, Baileys fetches the stored `url` as given, or `https://mmg.whatsapp.net` + `directPath` by string concatenation, and the sender chose both. Any reference that doesn't parse to WhatsApp's media hosts is refused (422) on every engine. Evolution gets only the checked node.
- **Memory and time.**
  - The claimed size is checked before fetching. The answer is read with a byte cap (Content-Length and counted stream) and decoded as it streams.
  - At most 3 downloads run per process, 1 per connection; more get 429, never a queue.
  - A slot is held until the MCP response has been delivered (5-minute deadline, or until the caller disconnects).
  - The fetch from Evolution has a 90 s deadline.
- **Budget.** `expensive: true`, so every call charges `NUXT_MCP_RATE_EXPENSIVE_PER_MINUTE`.
- **Untrusted metadata.** MIME type and file name are cleaned (from PR 1).

`read-messages`, every other tool and every existing token behave as before. The only visible change for existing tokens is the token-list summary wording.

## 🔗 Related Issue

Part of #266 (2 of 4). Builds on PR 1.

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
- [x] Functionality verified in development environment
- [x] No breaking changes introduced
- [ ] Tested with different connection types (if applicable)
- [x] `pnpm typecheck` passes
- [x] `pnpm bridge:typecheck` passes (if `apps/telegram-bridge` changed)
- [x] `pnpm cloud:typecheck` passes (if `apps/cloud` changed)
- [x] `pnpm test:emails` passes (if account emails changed)
- [x] `pnpm listings:check` passes (if MCP tools or the version changed): 23 tools

### Test plan (dev stack, no external server)

**Setup**

1. Run `cp .env.example .env`, then `pnpm services:up:whatsapp` and `pnpm dev`. On Apple Silicon, the pinned evolution-api-reforged image is amd64-only; run it under emulation with a compose override (`services: { evolution: { platform: linux/amd64 } }`, passed as a second `-f`).
2. Sign up, create a WhatsApp connection, and pair a test phone.
3. From another phone, send these into chat `JID`:
   - a photo
   - a PDF of about 100 KB
   - a document of 2–5 MB
   - a video over 5 MiB
   - optionally, a view-once photo
4. Have a second chat, `JID2`, with any message in it.
5. Mint three tokens on the connection:

| Token | Chats | Actions |
|---|---|---|
| `TOKEN_A` | only `JID` | Only selected: `read-messages`, plus **Media downloads → Download WhatsApp media** |
| `TOKEN_ALL` | All chats | All actions, media downloads **unticked** (stands for every existing token) |
| `TOKEN_B` | only `JID2` | Media downloads ticked |

```bash
APP=http://localhost:3000
mcp() { curl -s "$APP/mcp" -H "Authorization: Bearer $1" -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' -d "$2" | sed -n 's/^data: //p;/^{/p'; }
call() { mcp "$1" "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"$2\",\"arguments\":$3}}"; }
dl() { call "$1" download-media "{\"jid\":\"$2\",\"messageId\":\"$3\"}"; }
summary() { jq -r '.result | if .isError then "refused: \(.content[0].text)" else "\(.content[0].text | fromjson | "\(.mimeType) size=\(.size)") + " → " + .content[1].type end'; }
# Message ids from read-messages (hasMedia marks them):
call "$TOKEN_A" read-messages "{\"jid\":\"$JID\",\"limit\":20}" | jq -r '.result.content[0].text | fromjson | .messages[] | select(.hasMedia) | "\(.id) \(.mediaType) \(.fileSize)"'
PHOTO=...; PDF=...; DOC=...; VIDEO=...; OTHER=...   # OTHER = a message id from JID2
```

Running the whole plan within a minute can hit the default costly-tools budget (30 per minute); set `NUXT_MCP_RATE_EXPENSIVE_PER_MINUTE=0` for the run, except for the budget check in 7.

**1. Engine guard.** The dev stack runs evolution-api-reforged with no id index.

```bash
dl "$TOKEN_A" "$JID" "$PHOTO" | summary
# → refused: [501] … media downloads are off here …
docker compose -f docker-compose.dev.yml exec -T postgres psql -U evolution -d evolution <<'SQL'
CREATE INDEX CONCURRENTLY IF NOT EXISTS message_instance_key_id_idx ON "Message" ("instanceId", (key->>'id'));
SQL
# Restart `pnpm dev`: index presence is cached for ten minutes.
```

**2. Opt-in.**

```bash
mcp "$TOKEN_ALL" '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | jq -r '.result.tools[].name' | grep -c download-media   # → 0
mcp "$TOKEN_A"   '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | jq -r '.result.tools[].name' | grep -c download-media   # → 1
```

The token list shows `TOKEN_ALL` as "All chats · all actions except media downloads".

**3. Inline.**

```bash
dl "$TOKEN_A" "$JID" "$PHOTO" | summary        # → image/jpeg size=… → image
dl "$TOKEN_A" "$JID" "$PHOTO" | jq -r '.result.content[1].data' | base64 -d > photo.jpg   # opens as the photo
dl "$TOKEN_A" "$JID" "$PDF"   | summary        # → application/pdf size=… → resource
```

**4. No token, wrong token, wrong chat.**

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$APP/mcp" -H 'Content-Type: application/json' -d '{}'   # → 401
dl "$TOKEN_B" "$JID" "$PHOTO" | summary        # → refused: [403] This connector token is not scoped to …
dl "$TOKEN_A" "$JID" "$OTHER" | summary        # → refused: [404] No message with id … in this chat
```

The last call names a real message id from another chat; Evolution alone would have served it.

**5. Oversize.**

```bash
dl "$TOKEN_A" "$JID" "$VIDEO" | summary        # → refused: [413] This file is about … MB, larger than the 5 MB this connector returns.
```

**6. Two downloads at once on one connection.** The first holds its slot until its result is delivered, which `--limit-rate` slows down.

```bash
curl -s --limit-rate 100k "$APP/mcp" -H "Authorization: Bearer $TOKEN_A" -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' -o /dev/null \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"download-media\",\"arguments\":{\"jid\":\"$JID\",\"messageId\":\"$DOC\"}}}" &
sleep 4; dl "$TOKEN_A" "$JID" "$PHOTO" | summary   # → refused: [429] Another file download on this connection is still in progress …
wait;   # a 3 MB document at 100 KB/s takes about 40 s
 dl "$TOKEN_A" "$JID" "$PHOTO" | summary      # → image/jpeg … (the slot came back)
```

**7. Optional checks.**

- **View-once photo:** the call is refused with 422 ("view-once").
- **SSRF guard** (on a throwaway message; note the original value first):

```sql
UPDATE "Message" SET message = jsonb_set(message, '{imageMessage,directPath}', '".example.com/x"') WHERE key->>'id' = '<a photo id>';
```

  The download then answers 422 ("does not point at WhatsApp's media servers") without contacting Evolution.
- **Costly budget:** with `NUXT_MCP_RATE_EXPENSIVE_PER_MINUTE=2`, the third download within a minute gets 429.

## 📸 Screenshots (if applicable)

To add: the token dialog's "Media downloads" block, and the token list row "All chats · all actions except media downloads".

## ✅ Checklist

- [x] My changes follow the rules in `CLAUDE.md`
- [x] I have performed a self-review of my code
- [x] I have commented my code, particularly in hard-to-understand areas
- [x] I have made corresponding changes to the documentation
- [x] My changes generate no new warnings
- [x] I have manually tested my changes thoroughly
- [x] I have verified the changes work with different scenarios
- [ ] Any dependent changes have been merged and published (PR 1)

## 📝 Additional Notes

- **How it was tested.** I ran the plan above on this branch alone, against `docker-compose.dev.yml`. **Setup used.** No WhatsApp phone was paired to the dev stack, so the messages were synthetic rows in the dev Evolution database, one per case. Everything in the app ran for real: MCP calls, scope, SQL, the tools, links, slots and budgets. Only Evolution's `getBase64FromMediaMessage`, which needs a paired phone, was answered by a small local stub. The stub proxied every other route to the real dev Evolution, served real files, and recorded what the app sent it.
  - **Engine guard.** Reforged 3.1.0 without the id index answers 501, with no request to Evolution and a single operator warning. With the index (after a restart), downloads work. A server reporting 2.3.7 without the index downloads, skipping the id check by design.
  - **Opt-in.**
    - An all-actions token doesn't list the tool, and calling it gives "Tool download-media not found"; so does a token minted on `main`.
    - Ticking it under all-actions stores `tool_names: ["download-media"]` and lists it.
  - **Inline.** Photo, PDF, voice note, sticker, disappearing-chat photo and a 3 MB document all match their source SHA-256. An answer without `Content-Length` works too.
  - **What Evolution receives.** Only the media node, without `url` when `directPath` is present.
  - **Auth and scope.** No token or an unknown token: 401. Another chat's token: 403. A message from another chat: 404. An id another chat shares: 409.
  - **Oversize.** A claimed 6 MiB or 30 MB file: 413 with its size, without contacting Evolution. No size but 6 MiB actual: 413 without a size, cut while streaming.
  - **Refused with 422:** view-once (flag and wrapper), caption edit, text, and a `directPath` or `url` pointing at another host; the unsafe references never reach Evolution.
  - **Evolution's own errors.** 400 becomes 422 "could not provide". Evolution's own 413 and its 500 become 503.
  - **Concurrency.**
    - A second download on the connection while Evolution is slow gets 429.
    - So does a second download while a slow client is still reading a result. That client took 39 s for 3 MB at 100 KB/s.
    - So does the second of two downloads in one JSON-RPC batch.
    - The slot comes back each time.
  - **Budget.** With `NUXT_MCP_RATE_EXPENSIVE_PER_MINUTE=2`, the third download got HTTP 429 with `Retry-After: 30`, while `read-messages` still worked.
  - **Not run.** The token list's wording and the screenshots: those are dashboard-only, and this run used the API.
  - **Production.** The full series has also run in production on stock 2.3.7 and on reforged 3.1.0, with byte-identical downloads across the switch.
- **Memory.** Measured at 25 MiB: about 60 MiB peak for one download, against about 180 MiB when reading the body whole. Here the cap is 5 MiB.
- **Evolution itself isn't bounded by this.** It downloads and base64-encodes the whole file before answering, whatever its size; `docs/whatsapp.md` says so.
- **No test added**, per `CLAUDE.md`. I have a randomized round-trip test for `base64-field.ts` (plain `node --test`, like the email test) if you want it; see the question in #266.
