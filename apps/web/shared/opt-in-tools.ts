/**
 * Tools a token reaches only when they are ticked by name.
 *
 * "All actions" (`all_tools`) means every tool this build ships — including
 * tools added after the token was minted. That is the right default for the
 * ordinary read and send tools, and the wrong one for a tool that hands out a
 * different class of data: downloading the bytes of a photo, voice note or
 * document is not something an existing token should start doing because the
 * server was upgraded. So these tools are excluded from `all_tools` and are
 * granted only through `tool_names`, in both scope modes.
 *
 * Shared between the server (enforcement in `isToolAllowed`, persistence in
 * `scopeFromInput`) and the token dialog (which renders them as their own
 * group), so the two cannot drift.
 */
export const OPT_IN_TOOLS: readonly string[] = ['download-media', 'download-telegram-media']

export function isOptInTool(name: string): boolean {
  return OPT_IN_TOOLS.includes(name)
}
