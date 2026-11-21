# PR 3 of 4

- **Branch:** `agustinustheo:feat/media-3-signed-links` → `ju-li:main`
- **Title:** Hand larger WhatsApp files back as signed download links
- **Stacked on PR 2.** This PR's own commits: https://github.com/agustinustheo/automata-mcp/compare/feat/media-2-whatsapp-download...feat/media-3-signed-links

---

## 📋 Description

MCP clients cap how much tool output they accept; #180 notes that a multi-MB attachment "may be refused or cut off by the client". So above the inline limit, `download-media` now returns a short-lived link instead of refusing:

- **Up to `NUXT_MEDIA_INLINE_MAX_BYTES` (5 MiB):** inline, as in PR 2.
- **Up to `NUXT_MEDIA_MAX_BYTES` (25 MiB):** a URL under `/mcp-media/`, valid for 10 minutes.
- **The new `delivery` argument:** `auto` (the default, as above), `inline` (never a link), or `url` (always a link, with no fetch until it's followed).

### The link is a claim, not a credential

- **What the link is.** The URL carries `{kind, connection, token, chat, message, expiry}`, **sealed** with AES-256-GCM, not just signed: the chat id is a phone number, and proxies log paths. The URL holds no bytes. Following it fetches the file then.
- **Who can follow it.** `GET /mcp-media/<blob>` requires the **same** connector token in `Authorization`. It then re-runs everything the tool ran: `mcpLimitRefusal`, `isToolAllowed` (unticked since → 403), the token and organization budgets, the costly budget (charged as one tool call), and chat and message scope. A followed link is counted and recorded like a tool call.
- **What it reveals.**
  - No usable token → 401 for every link, real, expired or made up, checked before the link is opened.
  - Another valid token → 404 for every link.
  - Only the link's own token learns that it expired (410).
- **Auth split.** `isMcpPath` covers `/mcp-media/`, so the session middleware never reads a cookie there, and the path is redacted from logs like `/mcp/<token>`.
- **The key** comes from `NUXT_MEDIA_URL_SECRET`, or is random per process when unset, so links then end on restart. It is never derived from `NUXT_WEBHOOK_SECRET`, which every Evolution server and bridge receives.
- **Response headers:** `attachment` with the cleaned name, `nosniff`, `Content-Security-Policy: sandbox`, `no-store`, `no-referrer`.

### Delivery is bounded

- **The send.** The file is sent through `stream.pipeline` in 64 KiB slices, with a byte limit of min(cap, exact size) and `Content-Length` enforced both ways. Any failure destroys the response, so a cut-off file never ends looking whole.
- **The slot.** It is held until the file has been sent. The response is cut off when the caller disconnects, after 5 minutes, or when the kernel accepts under 64 KiB in 30 s (`bytesWritten − writableLength`, not bytes merely queued).

Clients that put the token in the URL path (`/mcp/<token>`) can't send the header a link needs; the tool and `howToFetch` text tell them to use `delivery: "inline"`.

Config: `NUXT_MEDIA_MAX_BYTES`, `NUXT_MEDIA_URL_SECRET`, wired through `.env.example`, `.env.selfhost.example`, `docker-compose.yml` and the all-in-one image. Links need `NUXT_PUBLIC_APP_URL`; without it, a link request answers 501 and says why.

## 🔗 Related Issue

Part of #266 (3 of 4). Builds on PR 2.

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

**Setup.** Same stack, tokens and message ids as PR 2: `TOKEN_A`, `TOKEN_B`, `JID`, `PHOTO`, `VIDEO` (over 5 MiB), the id index created, and the same `mcp` / `call` helpers. `NUXT_PUBLIC_APP_URL=http://localhost:3000` is already in `.env.example`.

```bash
link() { call "$1" download-media "{\"jid\":\"$2\",\"messageId\":\"$3\",\"delivery\":\"${4:-url}\"}" | jq -r '.result.content[0].text | fromjson | .url'; }
get() { curl -s -o "${3:-/dev/null}" -w '%{http_code} %{size_download}\n' ${2:+-H "Authorization: Bearer $2"} "$1"; }
FAKE=wamcp_$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=')
```

**1. auto: small inline, large as a link.**

```bash
call "$TOKEN_A" download-media "{\"jid\":\"$JID\",\"messageId\":\"$VIDEO\"}" | jq '.result.content[0].text | fromjson | {delivery, size, url, expiresAt}'
# → delivery "url", an /mcp-media/… url, expiresAt 10 min out
```

**2. The link gives the same bytes as inline, with download headers.**

```bash
U=$(link "$TOKEN_A" "$JID" "$PHOTO")
get "$U" "$TOKEN_A" link.jpg                     # → 200 <size>
call "$TOKEN_A" download-media "{\"jid\":\"$JID\",\"messageId\":\"$PHOTO\",\"delivery\":\"inline\"}" | jq -r '.result.content[1].data' | base64 -d > inline.jpg
shasum -a 256 link.jpg inline.jpg                # same hash
curl -sD - -o /dev/null -H "Authorization: Bearer $TOKEN_A" "$U" | grep -iE 'content-(disposition|security|type)|nosniff|cache-control'
```

**3. Who can follow it.**

```bash
get "$U"                                          # no token          → 401
get "$U" "$FAKE"                                  # unknown token     → 401
get "$U" "$TOKEN_B"                               # another token     → 404
get "$APP/mcp-media/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" "$TOKEN_A"   # made up → 404
get "$APP/mcp-media/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"              # made up, no token → 401
```

**4. Expiry.**

```bash
U=$(link "$TOKEN_A" "$JID" "$PHOTO"); sleep 610
get "$U" "$TOKEN_A"     # → 410 "This download link has expired …"
get "$U" "$TOKEN_B"     # → 404
```

**5. Scope re-checked when followed.** Mint a link, then untick *Media downloads* on `TOKEN_A` in the dashboard. `get "$U" "$TOKEN_A"` → 403. Tick it again afterwards.

**6. Oversize.** Restart with `NUXT_MEDIA_MAX_BYTES=3000000`:

```bash
call "$TOKEN_A" download-media "{\"jid\":\"$JID\",\"messageId\":\"$VIDEO\"}" | jq -r '.result.content[0].text'
# → [413] This file is about 6 MB, larger than the 2.9 MB this connector fetches.   (3,000,000 bytes shows as 2.9 MB)
```

**7. Two downloads at once, and a stalled reader.**

```bash
U=$(link "$TOKEN_A" "$JID" "$VIDEO")
curl -s --limit-rate 100k -o /dev/null -H "Authorization: Bearer $TOKEN_A" "$U" & sleep 2
get "$U" "$TOKEN_A"   # → 429 (one download per connection); wait for the first to finish
wait
curl -s --limit-rate 1k --max-time 70 -o /dev/null -H "Authorization: Bearer $TOKEN_A" "$U" &
sleep 35; get "$U" "$TOKEN_A"   # → 429: the stalled reader still holds the slot
sleep 30; get "$U" "$TOKEN_A"   # → 200: the server cut the stalled response and freed the slot
wait
# The server cuts at the second 30 s window, about 60 s in. The first window counts what the kernel's socket
# buffers absorb, which on loopback is up to several MB. The slow client only sees the cut once it has drained
# those buffers, so curl at 1 KB/s just runs to --max-time. A reader that then reads fast gets fewer bytes than
# Content-Length and a closed connection (curl error 18), never a complete file.
```

**8. Key handling.** Restart `pnpm dev` without `NUXT_MEDIA_URL_SECRET`: a link minted before the restart now answers 404. With `NUXT_MEDIA_URL_SECRET=$(openssl rand -hex 32)` set, a link survives a restart.

**9. Path-token client.** `call` against `$APP/mcp/$TOKEN_A` still works for `delivery: "inline"`. The returned `url` needs the header, which such clients can't send; `howToFetch` says so.

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
- [ ] Any dependent changes have been merged and published (PR 2)

## 📝 Additional Notes

- **How it was tested.** I ran the plan above on this branch alone, against `docker-compose.dev.yml`. **Setup used.** No WhatsApp phone was paired to the dev stack, so the messages were synthetic rows in the dev Evolution database, one per case. Everything in the app ran for real: MCP calls, scope, SQL, the tools, links, slots and budgets. Only Evolution's media route was stubbed, as in PR 2. Every item above ran; results:
  - **Delivery.**
    - `auto` returns a small file inline and a 6 MiB file (or one with no size) as a link.
    - A claimed 30 MB file is refused (413), also for `url`: no link is minted when the claimed size is over the overall cap.
    - `inline` on large files gives 413 with "Call again with delivery: \"url\"".
  - **Links.**
    - Photo, voice and 6 MiB video match their source SHA-256.
    - Headers: `attachment` with the file name, `nosniff`, `CSP: sandbox`, `no-store, private`, `no-referrer`, and an exact `Content-Length`.
  - **Who can follow a link.**
    - No token or an unknown token: 401. Another valid token, whether scoped elsewhere or to all chats with media: 404.
    - A made-up link: 404 with a token, 401 without.
    - The token passed in the query string instead of the header: 401.
  - **Expiry.** At 10 min: 410 "This download link has expired…" for its own token, 404 for other tokens, 401 with none.
  - **Scope re-checked when a link is followed.** Media unticked: 403. Chat removed from scope: 403. Token revoked: 401.
  - **Concurrency.** A second link, or a tool call, while a slow link downloads: 429. After the reader hung up: 200.
  - **Stalled reader.** See item 7: cut at about 60 s, and the client received 745 KB of 6 MiB with the connection closed.
  - **Restarts and keys.** With `NUXT_MEDIA_URL_SECRET` set, a link survives a restart. Without it, an older link gets 404.
  - **Budget.** Each followed link is charged: the 4th costly request in a minute at a budget of 3 got 429 with `Retry-After`.
  - **`NUXT_MEDIA_MAX_BYTES=3000000`.** A file exactly at the cap comes back inline. A link to a file with no size but 6 MiB actual answers 413 before any byte is sent.
  - **`NUXT_PUBLIC_APP_URL` unset.** `url` gives 501 "This server cannot issue download links…". A large `auto` gives 501 naming the inline cap. Small files still come back inline.
  - **Path-token client.** `/mcp/<token>` works with `delivery: "inline"`. A returned link without the header gets 401, as `howToFetch` warns.
  - **Regression.** The inline suite from PR 2 passes unchanged with `delivery: "inline"`.
  - **Not run.** The 5-minute delivery deadline (too long for the run).
- **Proxies.** Behind a reverse proxy that only forwards `/mcp`, `/mcp-media/` must be forwarded too; `docs/whatsapp.md` says so.
- **Replicas.** With several web replicas, set `NUXT_MEDIA_URL_SECRET` so any replica can open a link.
