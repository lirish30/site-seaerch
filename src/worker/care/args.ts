import { z } from "zod";

/**
 * The fixed shapes of every value that can reach a remote shell (Plan 12). Checked here on the worker side and again by the helper before it spawns `ssh`.
 * No space, quote, `$`, backtick, `;`, `|`, `&`, newline or `..` can match any of them.
 */
export const WP_ARG = {
  alias: /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/,
  path: /^\/(?!.*\.\.)[A-Za-z0-9._/-]{1,200}$/,
  slug: /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/,
  version: /^[0-9][0-9A-Za-z.+-]{0,30}$/,
  checkPath: /^\/(?!.*\.\.)[A-Za-z0-9._~/%-]{0,200}$/,
} as const;

/** Where a site's WordPress lives: a host alias name from the Mac's ssh config (never a key or password) and the install's folder. */
export const SshTarget = z.object({
  alias: z.string().regex(WP_ARG.alias, "That is not a valid SSH alias."),
  path: z.string().regex(WP_ARG.path, "That is not a valid WordPress folder."),
});
export type SshTarget = z.infer<typeof SshTarget>;
