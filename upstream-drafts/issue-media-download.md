# Title

Download the media a WhatsApp or Telegram message carries (opt-in tool)

# Body

Hi! I run Automata self-hosted and built a feature I'd like to offer upstream. I'm opening this before any PR to check that you want it and how you'd like to receive it.

## The problem

Today a model can see that a message is a photo, voice note or document (`[image]`, `[voice message]`, `[document]`), but it can't open it. `docs/whatsapp.md` says as much in the history caveats: "Media is not downloaded… the bytes still need `getBase64FromMediaMessage` per message." IMAP already has `get-email-attachment`. WhatsApp and Telegram have no equivalent.

## What I built

- **`read-messages` marks messages that carry a file:** `hasMedia`, `mediaType`, `mimetype`, `fileName`, `fileSize`. These are additive keys, absent on everything else. View-once media is never marked.
- **`download-media` (WhatsApp) and `download-telegram-media`:** read-only tools that fetch the file by chat and message id.
- **Opt-in.** "All actions" does not include them, so no existing token gains them on upgrade. They have their own checkboxes in the token dialog.
- **Scope first.** The message is looked up inside the token's chats in SQL. Evolution's own media route finds any message of the account by id alone.
- **Nothing stored.** Files are fetched on each call, the same rule as IMAP attachments. Telegram is streamed end to end through the bridge. WhatsApp holds one bounded buffer, because Evolution returns the whole file as base64 JSON; the app decodes it as it streams.
- **Inline up to 5 MiB, otherwise a link.** Small files come back in the tool result. Larger ones, up to 25 MiB, come back as a signed link that expires after 10 minutes. The link works only with the same token in the `Authorization` header, and the scope checks run again when it's followed. That matters because clients cap tool output, as #180 notes for large attachments. It adds a `/mcp-media/` route on the MCP side of the auth split: bearer only, never a cookie, path redacted.
- **Bounded like the rest of the app.** Byte caps check both the claimed size and the actual bytes, with 3 downloads per process (1 per connection) and deadlines. Each call and each followed link charges the costly-tools budget.
- **Both Evolution engines.** It works on stock `evoapicloud/evolution-api` 2.3.7 and on evolution-api-reforged 3.1.0. Reforged reloads the message by id alone and ignores the row we send, so where an index on `("instanceId", key->>'id')` exists the tool refuses an id another message of the account shares. Without that index it answers 501 on 3.x instead of scanning the account. The docs give the `CREATE INDEX` line, next to the other indexes on Evolution's tables (related: #242).

All five README checks pass (`typecheck`, `bridge:typecheck`, `cloud:typecheck`, `test:emails`, `listings:check`). I've been running the full series on a production deployment, first on stock 2.3.7 and then on reforged 3.1.0, with the same files byte for byte on both. Each PR will include a curl test plan you can run against the dev compose stack.

## Questions

1. **Do you want this upstream?** If it doesn't fit your plans, no problem; I'll keep it in my fork.
2. **Is 4 stacked PRs OK?** All together it's about 2,800 added lines, docs included, so I've split it:
   1. Media fields on `read-messages` (about 150 lines)
   2. The opt-in tool mechanism and `download-media`, inline only (about 1,260 lines, around 140 of them docs and config)
   3. Signed download links (about 510 lines)
   4. Telegram: bridge streaming plus `download-telegram-media` (about 970 lines)
   
   If you'd prefer a different split, or one PR, tell me.
3. **Would you take a `node --test` file?** The streaming base64 decoder (`base64-field.ts`) has no imports and runs in plain Node, like the email templates. I have a randomized round-trip test for it (chunk splits, escapes, malformed input, repeated fields). Should I add it as `apps/web/test/base64-field.test.mjs`, or leave tests out as `CLAUDE.md` says?

Thanks for Automata!
