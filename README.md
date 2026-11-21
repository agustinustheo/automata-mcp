# Upstream drafts: media downloads

Drafts for offering the media-download feature to ju-li/automata-mcp.
Kept here because the machine they were written on is being retired.
This branch holds documents only; it shares no history with the code.

- `upstream-drafts/issue-media-download.md`: the issue text, posted as
  https://github.com/ju-li/automata-mcp/issues/266.
- `upstream-drafts/pr-1..pr-4-*.md`: PR title and body drafts for the four
  stacked branches `feat/media-1-read-fields`, `feat/media-2-whatsapp-download`,
  `feat/media-3-signed-links` and `feat/media-4-telegram`, with dev-stack test
  plans and results. Nothing has been opened yet.

Before any PR: rebase the four branches onto current upstream main. Upstream
has changed `chats.ts` (#264) and the index-check options in `evolution-db.ts`.
