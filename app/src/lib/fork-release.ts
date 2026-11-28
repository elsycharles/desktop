/**
 * How this fork's builds differ from GitHub's. Kept apart from feature-flag.ts,
 * which upstream changes often, so that merging upstream doesn't conflict.
 */

/**
 * Should the app update itself automatically?
 *
 * Never in this fork: updates come from GitHub's update server, so updating
 * would replace this build with the official GitHub Desktop (without Smart
 * Split). New versions are published on the fork's releases page instead.
 */
export const enableAutoUpdates = () => false
