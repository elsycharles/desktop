import {
  CommitSuggestionHunks,
  ICommitSuggestion,
  SmartCommitSuggestion,
} from '../models/commit-suggestion'
import {
  DiffHunk,
  DiffLineType,
  DiffSelection,
  DiffSelectionType,
} from '../models/diff'

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Parses the response returned by Copilot for a smart commit split request.
 * The JSON may be wrapped in markdown fences.
 *
 * @param content  The raw response content
 * @param filePaths All the file paths that were sent to Copilot
 * @throws Error if the response isn't a valid smart split payload
 */
export function parseSmartCommitSuggestions(
  content: string,
  filePaths: ReadonlyArray<string>
): ReadonlyArray<SmartCommitSuggestion> {
  const jsonMatch =
    content.match(/```json\s*([\s\S]*?)```/) ||
    content.match(/```\s*([\s\S]*?)```/)
  const jsonStr = jsonMatch ? jsonMatch[1].trim() : content.trim()

  let parsed: unknown
  try {
    parsed = JSON.parse(jsonStr)
  } catch {
    throw new Error('Copilot returned invalid JSON for Smart Split')
  }

  return normalizeSmartCommitSuggestions(parsed, filePaths)
}

/**
 * Validates and sanitizes the parsed Copilot response:
 *  - only known file paths are kept (tolerating `./`, `a/` and `b/` prefixes)
 *  - files missing from every suggestion are added to the last one
 *  - suggestions without any file are dropped
 *  - hunk numbers are only kept for files of the suggestion
 *
 * @throws Error if the response isn't a valid smart split payload
 */
export function normalizeSmartCommitSuggestions(
  parsed: unknown,
  filePaths: ReadonlyArray<string>
): ReadonlyArray<SmartCommitSuggestion> {
  if (!isRecord(parsed)) {
    throw new Error('Unexpected response format from Copilot')
  }

  const { suggestions } = parsed

  if (!Array.isArray(suggestions) || suggestions.length === 0) {
    // Fallback: the model returned a single commit message
    if (typeof parsed.title === 'string' && parsed.title.trim().length > 0) {
      return [
        {
          summary: parsed.title.trim(),
          description:
            typeof parsed.description === 'string' ? parsed.description : '',
          files: [...filePaths],
          hunks: {},
        },
      ]
    }

    throw new Error('Unexpected response format from Copilot')
  }

  const knownPaths = new Set(filePaths)
  const toKnownPath = (value: unknown): string | null => {
    if (typeof value !== 'string') {
      return null
    }

    const candidates = [value, value.replace(/^(\.\/|a\/|b\/)/, '')]
    return candidates.find(c => knownPaths.has(c)) ?? null
  }

  const normalized = suggestions.filter(isRecord).map(suggestion => {
    const summary =
      typeof suggestion.summary === 'string'
        ? suggestion.summary
        : typeof suggestion.title === 'string'
        ? suggestion.title
        : ''

    const files = new Array<string>()
    for (const file of Array.isArray(suggestion.files)
      ? suggestion.files
      : []) {
      const path = toKnownPath(file)
      if (path !== null && !files.includes(path)) {
        files.push(path)
      }
    }

    const hunks: Record<string, ReadonlyArray<number>> = {}
    if (isRecord(suggestion.hunks)) {
      for (const [key, value] of Object.entries(suggestion.hunks)) {
        const path = toKnownPath(key)
        if (path === null || !files.includes(path) || !Array.isArray(value)) {
          continue
        }

        const numbers = value.filter(
          (n): n is number => Number.isInteger(n) && n > 0
        )
        if (numbers.length > 0) {
          hunks[path] = [...new Set(numbers)].sort((a, b) => a - b)
        }
      }
    }

    return {
      summary: summary.trim(),
      description:
        typeof suggestion.description === 'string'
          ? suggestion.description.trim()
          : '',
      files,
      hunks,
    }
  })

  if (normalized.length === 0) {
    throw new Error('Unexpected response format from Copilot')
  }

  // Every file must be committed by some suggestion: add the ones Copilot
  // forgot to the last suggestion.
  const assignedFiles = new Set(normalized.flatMap(s => s.files))
  const missingFiles = filePaths.filter(f => !assignedFiles.has(f))
  if (missingFiles.length > 0) {
    const last = normalized[normalized.length - 1]
    last.files = [...last.files, ...missingFiles]
  }

  return normalized.filter(s => s.files.length > 0)
}

/**
 * Returns a signature identifying a hunk by its added and deleted lines.
 *
 * Unlike the hunk index or line numbers, the signature doesn't change when
 * other hunks of the same file get committed, which lets us find the hunks
 * Copilot assigned to a suggestion after earlier suggestions were committed.
 */
export function getHunkSignature(hunk: DiffHunk): string {
  return hunk.lines
    .filter(l => l.type === DiffLineType.Add || l.type === DiffLineType.Delete)
    .map(l => l.text)
    .join('\n')
}

/**
 * Picks which of the current hunks of a file should be committed with the
 * given suggestion, when that file is shared with other pending suggestions.
 *
 * @param path              The path of the file
 * @param hunks             The current hunks of the file
 * @param suggestion        The suggestion being committed
 * @param pendingSharers    The other suggestions not committed yet that also
 *                          contain the file (including disabled ones)
 * @param enabledSharers    How many of `pendingSharers` will be committed
 *                          after this one
 * @param initialSignatures The signatures of the file's hunks before any
 *                          suggestion was committed, in diff order, or null
 *                          if Copilot didn't say how to split the file
 */
export function selectHunksForSuggestion(
  path: string,
  hunks: ReadonlyArray<DiffHunk>,
  suggestion: ICommitSuggestion,
  pendingSharers: ReadonlyArray<ICommitSuggestion>,
  enabledSharers: number,
  initialSignatures: ReadonlyArray<string> | null
): ReadonlyArray<DiffHunk> {
  if (pendingSharers.length === 0) {
    return hunks
  }

  const signaturesFor = (assigned: CommitSuggestionHunks) =>
    (assigned[path] ?? [])
      .map(n => initialSignatures?.[n - 1])
      .filter((s): s is string => s !== undefined)

  if (initialSignatures !== null) {
    const wanted = new Set(signaturesFor(suggestion.hunks))
    if (wanted.size > 0) {
      return hunks.filter(h => wanted.has(getHunkSignature(h)))
    }

    // This suggestion has no hunks of its own: leave the hunks claimed by the
    // other suggestions to them and take the rest.
    const claimedByOthers = new Set(
      pendingSharers.flatMap(s => signaturesFor(s.hunks))
    )
    if (claimedByOthers.size > 0) {
      return hunks.filter(h => !claimedByOthers.has(getHunkSignature(h)))
    }
  }

  // Copilot didn't say how to split this file. When it is only shared with
  // suggestions that won't be committed now, commit it whole.
  if (enabledSharers === 0) {
    return hunks
  }

  // Otherwise share the hunks in order, keeping at least one hunk for each
  // of the remaining enabled suggestions when possible.
  const take = Math.max(
    1,
    Math.min(
      Math.floor(hunks.length / (enabledSharers + 1)),
      hunks.length - enabledSharers
    )
  )
  return hunks.slice(0, take)
}

/** Returns a selection of a file's diff that includes only the given hunks */
export function getSelectionForHunks(
  hunks: ReadonlyArray<DiffHunk>
): DiffSelection {
  let selection = DiffSelection.fromInitialSelection(DiffSelectionType.None)
  for (const hunk of hunks) {
    // unifiedDiffEnd is inclusive
    selection = selection.withRangeSelection(
      hunk.unifiedDiffStart,
      hunk.unifiedDiffEnd - hunk.unifiedDiffStart + 1,
      true
    )
  }
  return selection
}
