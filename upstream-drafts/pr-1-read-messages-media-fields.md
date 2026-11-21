# PR 1 of 4

- **Branch:** `agustinustheo:feat/media-1-read-fields` → `ju-li:main`
- **Title:** Mark WhatsApp messages that carry a file in read-messages

---

## 📋 Description

This is the first of four PRs for media downloads (see #266). It only adds information to `read-messages`. No new tool, route or setting.

A WhatsApp message holding a photo, video, video note, voice note, audio file, document or sticker now carries:

- `hasMedia: true`
- `mediaType`: `image`, `video`, `video-note`, `audio`, `voice`, `document` or `sticker`
- `mimetype`
- `fileName` (documents) and `fileSize`, when the sender's device gave them

The keys are **additive**: absent on every other message, never `false`. Existing output is otherwise unchanged.

- **Same unwrapping as `classifyContent`.** Edits, `associatedChildMessage` and the rest are handled the same way, plus one `ephemeralMessage` level: a photo in a disappearing chat is still a photo.
- **View-once media is never marked,** whether flagged on the node or by a `viewOnceMessage*` wrapper. This follows the existing non-goal in `CLAUDE.md`. A node without a `mediaKey` (a caption edit) doesn't count either.
- **Every value is the sender's claim.** `cleanMimeType` reduces the MIME type to `type/subtype` or octet-stream. `cleanFileName` strips control characters, slashes, `.` and `..`, and clips by code point. `fileLength` is a protobuf uint64 (number, digit string or Long) and is read without guessing.

Files: `apps/web/server/utils/chats.ts` and a new `apps/web/server/utils/media.ts` holding the two cleaners. Docs: `CLAUDE.md` (MCP wiring), `docs/whatsapp.md` ("Media in messages"), `docs/using-automata.md`.

## 🔗 Related Issue

Part of #266 (1 of 4). The next PR builds on this one.

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
- [x] `pnpm listings:check` passes (if MCP tools or the version changed)

### Test plan (dev stack, no external server)

**Setup**

1. Run `cp .env.example .env`, then `pnpm services:up:whatsapp` and `pnpm dev`. On Apple Silicon, the pinned evolution-api-reforged image is amd64-only; run it under emulation with a compose override (`services: { evolution: { platform: linux/amd64 } }`, passed as a second `-f`).
2. Sign up at http://localhost:3000, create a WhatsApp connection, and pair a test phone.
3. From another phone, send that number, in one chat:
   - a photo
   - a PDF
   - a voice note
   - a plain text message
   - optionally, a view-once photo
4. Mint a connector token on the connection: only that chat, with `read-messages` ticked.

```bash
APP=http://localhost:3000
TOKEN=wamcp_...            # the token above
JID=...@s.whatsapp.net     # the chat, as list-chats returns it
mcp() { curl -s "$APP/mcp" -H "Authorization: Bearer $1" -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' -d "$2" | sed -n 's/^data: //p;/^{/p'; }
call() { mcp "$1" "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"$2\",\"arguments\":$3}}"; }
```

**Read the chat**

```bash
call "$TOKEN" read-messages "{\"jid\":\"$JID\",\"limit\":20}" \
  | jq '.result.content[0].text | fromjson | .messages[] | {id, text, hasMedia, mediaType, mimetype, fileName, fileSize}'
```

Expected:

- **Photo:** `hasMedia: true`, `mediaType: "image"`, `mimetype: "image/jpeg"`, a `fileSize`.
- **PDF:** `mediaType: "document"`, `mimetype: "application/pdf"`, its `fileName` and `fileSize`.
- **Voice note:** `mediaType: "voice"`, mimetype `audio/ogg`.
- **Text message:** all five media keys `null` in this `jq` output, because they are absent from the response.
- **View-once photo:** no `hasMedia`. It reads as before.

Also check that the full response for a text message is unchanged from `main` (same keys, same order).

## 📸 Screenshots (if applicable)

Not applicable.

## ✅ Checklist

- [x] My changes follow the rules in `CLAUDE.md`
- [x] I have performed a self-review of my code
- [x] I have commented my code, particularly in hard-to-understand areas
- [x] I have made corresponding changes to the documentation
- [x] My changes generate no new warnings
- [x] I have manually tested my changes thoroughly
- [x] I have verified the changes work with different scenarios
- [x] Any dependent changes have been merged and published

## 📝 Additional Notes

- **How it was tested.** I ran the plan above on this branch alone, against `docker-compose.dev.yml` (evolution-api-reforged 3.1.0). **Setup used.** No WhatsApp phone was paired to the dev stack, so the messages were synthetic rows in the dev Evolution database, one per case. Everything in the app ran for real: MCP calls, scope, SQL, the tools, links, slots and budgets. 
  - **Fields, all as expected:**
    - photo (`fileLength` as a digit string): `image`, `image/jpeg`, size;
    - PDF (as a number): `document` with `fileName`;
    - voice note (as a Long `{low, high}`): `voice`, `audio/ogg` (codec parameters stripped);
    - video with no `fileLength`: no `fileSize`;
    - sticker: `sticker`, `image/webp`;
    - disappearing-chat photo: `image`.
  - **Not marked, as expected:** view-once photo (flag on the node), view-once photo (wrapper), caption edit without `mediaKey`, plain text.
  - **Unchanged:** compared with upstream `main` on the same 17 messages, every other field of every message is identical, with the same key order. The new keys appear only on messages with a file.
  - **Production:** the same code has also run on stock 2.3.7 and on reforged 3.1.0 as part of the full series.
- **What the fields do not promise.** They describe what the sender's device reported. They don't say whether WhatsApp still holds the file; old media can expire on WhatsApp's servers.
