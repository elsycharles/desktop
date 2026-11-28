/**
 * Smart Split: Copilot splits the selected changes into several commits.
 *
 * This file holds all of Smart Split's logic, so that this fork changes as
 * little as possible of upstream's files, which keeps merging upstream free of
 * conflicts. It works through the stores' own members, some of them private:
 * the type check still catches any upstream change to what it relies on.
 */

import type { CopilotClient } from '@github/copilot-sdk'
import { Account } from '../../models/account'
import { ICommitContext } from '../../models/commit'
import { DefaultCommitMessage } from '../../models/commit-message'
import {
  ICommitSuggestion,
  SmartCommitSuggestion,
} from '../../models/commit-suggestion'
import { DiffType } from '../../models/diff'
import { PopupType } from '../../models/popup'
import { Repository } from '../../models/repository'
import { WorkingDirectoryFileChange } from '../../models/status'
import { createCopilotInMemorySessionFsProvider } from '../copilot-in-memory-session-fs-provider'
import {
  awaitCancellableCopilotOperation,
  getCopilotMessageSession,
  sendCopilotMessageRequest,
} from '../copilot-operation'
import { ErrorWithMetadata } from '../error-with-metadata'
import { formatCommitMessage } from '../format-commit-message'
import { getAccountForCopilot } from '../get-account-for-repository'
import { createCommit, getFilesDiffText, getWorkingDirectoryDiff } from '../git'
import { offsetFromNow } from '../offset-from'
import {
  buildSmartSplitSystemPrompt,
  buildSmartSplitUserPrompt,
  generateSmartSplitDiffTag,
  ICommitFormatConfig,
} from '../smart-commit-prompt'
import {
  getHunkSignature,
  getSelectionForHunks,
  parseSmartCommitSuggestions,
  selectHunksForSuggestion,
} from '../smart-commit-suggestions'
import type { AppStore } from './app-store'
import {
  CommitMessageGenerationCancelledError,
  CopilotModelRequest,
  CopilotStore,
} from './copilot-store'

/**
 * Default timeout (in milliseconds) for Smart Split requests, which take
 * longer than generating a single commit message.
 */
const SmartSplitRequestTimeoutMs = 120000

/** Smart Split is attributed to commit message generation in telemetry. */
const SmartSplitClientName = 'github/desktop:commit-message-generation'

/**
 * Asks Copilot to split the selected files' changes into commit suggestions,
 * and shows them in place of the commit message form.
 */
export async function generateSmartCommitSuggestions(
  store: AppStore,
  repository: Repository,
  filesSelected: ReadonlyArray<WorkingDirectoryFileChange>,
  formatConfig?: ICommitFormatConfig
): Promise<boolean> {
  const account = getAccountForCopilot(store['accounts'], repository)

  if (!account) {
    if (__DEV__) {
      store._beginDotComSignIn()
      await store._showPopup({ type: PopupType.SignIn })
    }
    return false
  }

  // Smart Split creates new commits, it can't amend the last one.
  if (
    filesSelected.length === 0 ||
    store['repositoryStateCache'].get(repository).commitToAmend !== null
  ) {
    return false
  }

  store._setCommitMessageGenerationButtonClicked()

  const disclaimerLastSeen = store['commitMessageGenerationDisclaimerLastSeen']
  if (!disclaimerLastSeen || offsetFromNow(-30, 'days') > disclaimerLastSeen) {
    await store._showPopup({
      type: PopupType.GenerateCommitMessageDisclaimer,
      repository,
      filesSelected,
      smartSplit: { formatConfig },
    })
    return false
  }

  return store['withIsGeneratingCommitMessage'](repository, async signal => {
    try {
      // Smart Split always commits whole files (split by hunks), so it
      // analyzes the whole content of every file, even partially selected.
      const files = filesSelected.map(f => f.withIncludeAll(true))
      const diff = await getFilesDiffText(repository, files)
      if (!diff) {
        return false
      }

      const filePaths = files.map(f => f.path)
      const suggestions = await requestSmartCommitSuggestions(
        store['copilotStore'],
        account,
        diff,
        filePaths,
        repository.path,
        await store['resolveCopilotModelRequest'](
          store['getSelectedCopilotModels'](account)[
            'commit-message-generation'
          ] ?? null
        ),
        formatConfig,
        signal
      )

      if (signal.aborted) {
        return false
      }

      setCommitSuggestions(
        store,
        repository,
        suggestions.map(s => ({ ...s, enabled: true }))
      )

      store['statsStore'].increment('generateCommitMessageCount')
    } catch (e) {
      if (e instanceof CommitMessageGenerationCancelledError) {
        return false
      }

      store['emitError'](
        new ErrorWithMetadata(e, {
          repository,
        })
      )
      return false
    }

    return true
  })
}

/** Replaces the repository's Smart Split suggestions; null dismisses them. */
export function setCommitSuggestions(
  store: AppStore,
  repository: Repository,
  suggestions: ReadonlyArray<ICommitSuggestion> | null
): void {
  store['repositoryStateCache'].update(repository, () => ({
    commitSuggestions:
      suggestions !== null && suggestions.length > 0 ? suggestions : null,
  }))
  store['emitUpdate']()
}

/**
 * Commits, in order, every enabled Smart Split suggestion of the repository.
 * Committed suggestions are removed from the list; disabled ones are kept.
 */
export async function executeSmartCommitSuggestions(
  store: AppStore,
  repository: Repository
): Promise<boolean> {
  const repositoryStateCache = store['repositoryStateCache']
  const state = repositoryStateCache.get(repository)
  const suggestions = state.commitSuggestions ?? []
  const toCommit = suggestions.filter(s => s.enabled)

  if (
    toCommit.length === 0 ||
    toCommit.some(s => s.summary.trim().length === 0)
  ) {
    return false
  }

  const gitStore = store['gitStoreCache'].get(repository)
  const committed = new Set<ICommitSuggestion>()
  const affectedFiles = state.changesState.workingDirectory.files.filter(f =>
    toCommit.some(s => s.files.includes(f.path))
  )

  const success = await store['withIsCommitting'](
    repository,
    affectedFiles,
    async () => {
      // Copilot identifies hunks by their position in the diff, which changes
      // as soon as a first suggestion is committed, so we remember the hunks
      // of every split file before committing anything.
      const initialHunks = await getInitialHunkSignatures(
        store,
        repository,
        suggestions
      )

      for (const suggestion of toCommit) {
        await store['refreshChangesSection'](repository, {
          includingStatus: true,
          clearPartialState: false,
        })

        const filesToCommit = await getFilesToCommit(
          store,
          repository,
          suggestion,
          suggestions.filter(s => s !== suggestion && !committed.has(s)),
          initialHunks
        )

        // Nothing left to commit (e.g. the changes were discarded meanwhile)
        if (filesToCommit.length === 0) {
          committed.add(suggestion)
          continue
        }

        const context: ICommitContext = {
          summary: suggestion.summary.trim(),
          description: suggestion.description.trim() || null,
        }

        const result = await gitStore.performFailableOperation(
          async () => {
            const message = await formatCommitMessage(repository, context)
            let aborted = false
            return createCommit(repository, message, filesToCommit, {
              onHookProgress: store['onHookProgress'](repository),
              onHookFailure: store['onHookFailure'](() => (aborted = true)),
              onTerminalOutputAvailable: subscribeToCommitOutput => {
                repositoryStateCache.update(repository, state => ({
                  ...state,
                  subscribeToCommitOutput,
                }))
              },
              noVerify: state.skipCommitHooks,
              signOff: state.signOffCommits,
            }).catch(err => (aborted ? undefined : Promise.reject(err)))
          },
          { gitContext: { kind: 'commit' }, repository }
        )

        if (result === undefined) {
          return false
        }

        committed.add(suggestion)
        await store['_recordCommitStats'](
          gitStore,
          repository,
          state,
          context,
          filesToCommit,
          false
        )
      }

      return true
    }
  )

  await store['refreshChangesSection'](repository, {
    includingStatus: true,
    clearPartialState: true,
  })

  // Keep the suggestions that weren't committed, restricted to the files
  // that still have changes.
  const changedPaths = new Set(
    repositoryStateCache
      .get(repository)
      .changesState.workingDirectory.files.map(f => f.path)
  )
  setCommitSuggestions(
    store,
    repository,
    suggestions
      .filter(s => !committed.has(s))
      .map(s => ({ ...s, files: s.files.filter(f => changedPaths.has(f)) }))
      .filter(s => s.files.length > 0)
  )

  if (committed.size > 0) {
    await gitStore.setCommitMessage(DefaultCommitMessage)
  }

  await store._refreshRepository(repository)

  // Make sure all the new commits appear in the history
  await store['refreshHistorySection'](repository)

  return success
}

/**
 * Returns, for every file that Copilot split by hunks across several
 * suggestions, the signatures of its hunks in diff order.
 */
async function getInitialHunkSignatures(
  store: AppStore,
  repository: Repository,
  suggestions: ReadonlyArray<ICommitSuggestion>
): Promise<ReadonlyMap<string, ReadonlyArray<string>>> {
  const { files } =
    store['repositoryStateCache'].get(repository).changesState.workingDirectory
  const signatures = new Map<string, ReadonlyArray<string>>()

  for (const file of files) {
    const isSplitByHunks =
      suggestions.filter(s => s.files.includes(file.path)).length > 1 &&
      suggestions.some(s => s.hunks[file.path] !== undefined)

    if (!isSplitByHunks) {
      continue
    }

    const diff = await getWorkingDirectoryDiff(repository, file)
    if (diff.kind === DiffType.Text || diff.kind === DiffType.LargeText) {
      signatures.set(file.path, diff.hunks.map(getHunkSignature))
    }
  }

  return signatures
}

/**
 * Returns the files (with the right hunks selected) to commit for the given
 * Smart Split suggestion, based on the current working directory.
 *
 * @param pending The other suggestions that haven't been committed yet
 */
async function getFilesToCommit(
  store: AppStore,
  repository: Repository,
  suggestion: ICommitSuggestion,
  pending: ReadonlyArray<ICommitSuggestion>,
  initialHunks: ReadonlyMap<string, ReadonlyArray<string>>
): Promise<ReadonlyArray<WorkingDirectoryFileChange>> {
  const { files } =
    store['repositoryStateCache'].get(repository).changesState.workingDirectory
  const filesToCommit = new Array<WorkingDirectoryFileChange>()

  for (const path of suggestion.files) {
    const file = files.find(f => f.path === path)
    if (file === undefined) {
      continue
    }

    const sharers = pending.filter(s => s.files.includes(path))
    if (sharers.length === 0) {
      filesToCommit.push(file.withIncludeAll(true))
      continue
    }

    const diff = await getWorkingDirectoryDiff(repository, file)
    if (diff.kind !== DiffType.Text && diff.kind !== DiffType.LargeText) {
      // Binary files, images, submodules… can't be partially committed
      filesToCommit.push(file.withIncludeAll(true))
      continue
    }

    const hunks = selectHunksForSuggestion(
      path,
      diff.hunks,
      suggestion,
      sharers,
      sharers.filter(s => s.enabled).length,
      initialHunks.get(path) ?? null
    )

    if (hunks.length === 0) {
      continue
    }

    if (hunks.length === diff.hunks.length) {
      filesToCommit.push(file.withIncludeAll(true))
      continue
    }

    filesToCommit.push(file.withSelection(getSelectionForHunks(hunks)))
  }

  return filesToCommit
}

/**
 * Splits the given diff into several commit suggestions using Copilot.
 *
 * @param diff The diff of the files to split, in git format
 * @param filePaths All the file paths in the diff
 * @param request Optional model selection (built-in or BYOK)
 * @param formatConfig The user's commit message format, if any
 * @throws CommitMessageGenerationCancelledError if `signal` is aborted
 */
export async function requestSmartCommitSuggestions(
  copilotStore: CopilotStore,
  account: Account,
  diff: string,
  filePaths: ReadonlyArray<string>,
  repositoryPath: string,
  request?: CopilotModelRequest | null,
  formatConfig?: ICommitFormatConfig,
  signal?: AbortSignal
): Promise<ReadonlyArray<SmartCommitSuggestion>> {
  const throwIfCancelled = () => {
    if (signal?.aborted) {
      throw new CommitMessageGenerationCancelledError()
    }
  }

  throwIfCancelled()
  const credentials = copilotStore['createCredentialContext'](account)

  // Splitting changes needs more reasoning than writing a single commit
  // message, which is what the conflict resolution config provides.
  const { modelId, reasoningEffort, provider, timeoutMs } = copilotStore[
    'resolveConflictModelConfig'
  ](account, request)

  let client: CopilotClient | null = null
  let session: Awaited<ReturnType<CopilotClient['createSession']>> | null = null

  try {
    client = await awaitCancellableCopilotOperation(
      () => copilotStore['createClient'](account, repositoryPath, credentials),
      {
        signal,
        cancellationError: () => new CommitMessageGenerationCancelledError(),
        disposeLateValue: lateClient => copilotStore['stopClient'](lateClient),
      }
    )
    throwIfCancelled()

    const diffTag = generateSmartSplitDiffTag()

    session = await copilotStore['createCancellableSession'](
      client,
      {
        clientName: SmartSplitClientName,
        model: modelId,
        reasoningEffort,
        provider,
        systemMessage: {
          // Append so that copilot-instructions.md is still honored.
          mode: 'append',
          content: buildSmartSplitSystemPrompt(
            filePaths,
            formatConfig,
            diffTag
          ),
        },
        coauthorEnabled: false,
        availableTools: [],
        enableSessionStore: false,
        createSessionFsProvider: createCopilotInMemorySessionFsProvider,
        onPermissionRequest: async () => ({
          kind: 'reject',
        }),
      },
      signal,
      () => new CommitMessageGenerationCancelledError()
    )

    throwIfCancelled()

    const response = await sendCopilotMessageRequest(
      getCopilotMessageSession(session),
      { prompt: buildSmartSplitUserPrompt(diff, diffTag) },
      timeoutMs ?? SmartSplitRequestTimeoutMs,
      {
        signal,
        cancellationError: () => new CommitMessageGenerationCancelledError(),
      }
    )

    throwIfCancelled()

    if (!response || !response.data.content) {
      throw new Error('No response from Copilot')
    }

    return parseSmartCommitSuggestions(response.data.content, filePaths)
  } catch (e) {
    if (e instanceof CommitMessageGenerationCancelledError) {
      throw e
    }

    if (signal?.aborted) {
      throw new CommitMessageGenerationCancelledError()
    }

    log.warn('Smart Split: Failed to generate the suggestions', e)
    throw e
  } finally {
    await session?.disconnect().catch(() => {})

    if (client !== null) {
      copilotStore['stopClient'](client)
    }
  }
}
