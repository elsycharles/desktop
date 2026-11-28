/**
 * Smart Split's actions for the UI, which reaches the app store through the
 * dispatcher. They're here rather than in the dispatcher so that this fork
 * doesn't change it: see lib/stores/smart-split.ts.
 */

import { ICommitSuggestion } from '../../models/commit-suggestion'
import { Repository } from '../../models/repository'
import { WorkingDirectoryFileChange } from '../../models/status'
import { ICommitFormatConfig } from '../../lib/smart-commit-prompt'
import { Popup, PopupType } from '../../models/popup'
import * as SmartSplit from '../../lib/stores/smart-split'
import type { Dispatcher } from '../dispatcher'

const appStoreOf = (dispatcher: Dispatcher) => dispatcher['appStore']

/** Asks Copilot to split the given files' changes into several commits. */
export function generateSmartCommitSuggestions(
  dispatcher: Dispatcher,
  repository: Repository,
  filesSelected: ReadonlyArray<WorkingDirectoryFileChange>,
  formatConfig?: ICommitFormatConfig
) {
  return SmartSplit.generateSmartCommitSuggestions(
    appStoreOf(dispatcher),
    repository,
    filesSelected,
    formatConfig
  )
}

/**
 * Starts the Smart Split that was waiting for the commit message generation
 * disclaimer to be accepted, if it's one. Returns whether it was.
 */
export function startSmartSplitAfterDisclaimer(
  dispatcher: Dispatcher,
  popup: Popup & { type: PopupType.GenerateCommitMessageDisclaimer }
): boolean {
  if (popup.smartSplit === undefined) {
    return false
  }
  generateSmartCommitSuggestions(
    dispatcher,
    popup.repository,
    popup.filesSelected,
    popup.smartSplit.formatConfig
  )
  return true
}

/** Updates the repository's suggestions; null dismisses them. */
export function setCommitSuggestions(
  dispatcher: Dispatcher,
  repository: Repository,
  suggestions: ReadonlyArray<ICommitSuggestion> | null
) {
  return SmartSplit.setCommitSuggestions(
    appStoreOf(dispatcher),
    repository,
    suggestions
  )
}

/** Commits all the enabled suggestions of a repository, in order. */
export function executeSmartCommitSuggestions(
  dispatcher: Dispatcher,
  repository: Repository
) {
  return SmartSplit.executeSmartCommitSuggestions(
    appStoreOf(dispatcher),
    repository
  )
}
