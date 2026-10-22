/**
 * Hunk numbers (1-based, in the order they appear in the file's diff) keyed
 * by file path.
 */
export type CommitSuggestionHunks = Readonly<
  Record<string, ReadonlyArray<number>>
>

/**
 * Represents a single AI-suggested commit from the smart split feature.
 * Each suggestion groups semantically related files with an AI-generated
 * commit message.
 */
export interface ICommitSuggestion {
  /** Commit title following the user's format template */
  readonly summary: string
  /** Optional commit body/description */
  readonly description: string
  /** File paths belonging to this commit group */
  readonly files: ReadonlyArray<string>
  /**
   * For files split across several suggestions, the hunks of that file that
   * belong to this suggestion. Files without an entry are committed whole
   * (or share their hunks evenly when Copilot didn't say how to split them).
   */
  readonly hunks: CommitSuggestionHunks
  /** Whether this suggestion is included for committing */
  readonly enabled: boolean
}

/** A commit suggestion as returned by the AI, before the user toggles it */
export type SmartCommitSuggestion = Omit<ICommitSuggestion, 'enabled'>
