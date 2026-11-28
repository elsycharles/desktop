import * as React from 'react'
import { showContextualMenu } from '../../lib/menu-item'
import { Commit } from '../../models/commit'
import { ICommitSuggestion } from '../../models/commit-suggestion'
import { DiffSelectionType } from '../../models/diff'
import { Repository } from '../../models/repository'
import {
  WorkingDirectoryFileChange,
  WorkingDirectoryStatus,
} from '../../models/status'
import { ICommitFormatConfig } from '../../lib/smart-commit-prompt'
import { Dispatcher } from '../dispatcher'
import {
  executeSmartCommitSuggestions,
  generateSmartCommitSuggestions,
  setCommitSuggestions,
} from '../lib/smart-split'
import { SuggestedCommitList, loadSavedFormat } from './suggested-commit-list'

const smartSplitHeightKey = 'smart-split-panel-height'
const defaultSmartSplitHeight = 300
const minSmartSplitHeight = 150
const maxSmartSplitHeight = 600

/** Starts a Smart Split of the given files, in the repository's saved format. */
export function startSmartSplit(
  dispatcher: Dispatcher,
  repository: Repository,
  filesSelected: ReadonlyArray<WorkingDirectoryFileChange>
) {
  dispatcher.incrementMetric('generateCommitMessageButtonClickCount')
  const saved = loadSavedFormat(repository)
  const formatConfig = saved.template.trim().length > 0 ? saved : undefined
  generateSmartCommitSuggestions(
    dispatcher,
    repository,
    filesSelected,
    formatConfig
  )
}

/**
 * Offers Smart Split next to generating a commit message when the Copilot
 * button is clicked. Returns false when Smart Split can't be used, for the
 * commit message to be generated right away.
 */
export function showSmartSplitMenu(
  filesSelected: ReadonlyArray<WorkingDirectoryFileChange>,
  commitToAmend: Commit | null,
  onSmartSplitCommits:
    | ((filesSelected: ReadonlyArray<WorkingDirectoryFileChange>) => void)
    | undefined,
  generateCommitMessage: () => void
): boolean {
  // Smart Split creates new commits, so it can't be used while amending.
  if (
    onSmartSplitCommits === undefined ||
    commitToAmend !== null ||
    filesSelected.length === 0
  ) {
    return false
  }

  const smartSplitLabel =
    filesSelected.length === 1
      ? __DARWIN__
        ? 'Smart Split'
        : 'Smart split'
      : __DARWIN__
      ? `Smart Split (${filesSelected.length} Files)`
      : `Smart split (${filesSelected.length} files)`

  showContextualMenu([
    {
      label: __DARWIN__ ? 'Generate Commit Message' : 'Generate commit message',
      action: generateCommitMessage,
    },
    {
      label: smartSplitLabel,
      action: () => onSmartSplitCommits(filesSelected),
    },
  ])
  return true
}

/** Whether Smart Split suggestions are shown, which locks the file selection. */
export function hasSmartSplitSuggestions(
  suggestions: ReadonlyArray<ICommitSuggestion> | null | undefined
): suggestions is ReadonlyArray<ICommitSuggestion> {
  return (
    suggestions !== null && suggestions !== undefined && suggestions.length > 0
  )
}

/** Shown on the checkboxes of the files while their selection is locked. */
export const SmartSplitLockedSelectionTooltip =
  'File selection is locked while Smart Split suggestions are active. Dismiss the suggestions to change file selection.'

interface ISmartSplitPanelProps {
  readonly dispatcher: Dispatcher
  readonly repository: Repository
  readonly workingDirectory: WorkingDirectoryStatus
  readonly suggestions: ReadonlyArray<ICommitSuggestion>
  readonly isCommitting: boolean
  readonly isLoading: boolean
}

interface ISmartSplitPanelState {
  /** Height of the panel, persisted to localStorage */
  readonly height: number
}

/**
 * Smart Split's suggestions, shown in place of the commit message form, in a
 * panel the user can resize.
 */
export class SmartSplitPanel extends React.Component<
  ISmartSplitPanelProps,
  ISmartSplitPanelState
> {
  private resizeStartY: number | null = null
  private resizeStartHeight: number | null = null

  public constructor(props: ISmartSplitPanelProps) {
    super(props)

    const savedHeight = localStorage.getItem(smartSplitHeightKey)
    const height = savedHeight
      ? Math.max(
          minSmartSplitHeight,
          Math.min(
            maxSmartSplitHeight,
            parseInt(savedHeight, 10) || defaultSmartSplitHeight
          )
        )
      : defaultSmartSplitHeight

    this.state = { height }
  }

  public componentWillUnmount() {
    document.removeEventListener('mousemove', this.handleResizeDragMove)
    document.removeEventListener('mouseup', this.handleResizeDragStop)
  }

  private handleResizeDragStart = (e: React.MouseEvent<HTMLButtonElement>) => {
    this.resizeStartY = e.clientY
    this.resizeStartHeight = this.state.height
    document.addEventListener('mousemove', this.handleResizeDragMove)
    document.addEventListener('mouseup', this.handleResizeDragStop)
    e.preventDefault()
  }

  private handleResizeDragMove = (e: MouseEvent) => {
    if (this.resizeStartY === null || this.resizeStartHeight === null) {
      return
    }
    // Dragging up increases panel height, dragging down decreases it
    const deltaY = this.resizeStartY - e.clientY
    const height = Math.max(
      minSmartSplitHeight,
      Math.min(maxSmartSplitHeight, this.resizeStartHeight + deltaY)
    )
    this.setState({ height })
    e.preventDefault()
  }

  private handleResizeDragStop = (e: MouseEvent) => {
    document.removeEventListener('mousemove', this.handleResizeDragMove)
    document.removeEventListener('mouseup', this.handleResizeDragStop)
    localStorage.setItem(smartSplitHeightKey, String(this.state.height))
    e.preventDefault()
  }

  private handleResizeDoubleClick = () => {
    this.setState({ height: defaultSmartSplitHeight })
    localStorage.removeItem(smartSplitHeightKey)
  }

  private onSuggestionsUpdated = (
    suggestions: ReadonlyArray<ICommitSuggestion>
  ): void => {
    setCommitSuggestions(
      this.props.dispatcher,
      this.props.repository,
      suggestions
    )
  }

  private onCommitAll = (): void => {
    executeSmartCommitSuggestions(this.props.dispatcher, this.props.repository)
  }

  private onRegenerate = (formatConfig?: ICommitFormatConfig): void => {
    const filesSelected = this.props.workingDirectory.files.filter(
      f => f.selection.getSelectionType() !== DiffSelectionType.None
    )
    generateSmartCommitSuggestions(
      this.props.dispatcher,
      this.props.repository,
      filesSelected,
      formatConfig
    )
  }

  private onDismiss = (): void => {
    setCommitSuggestions(this.props.dispatcher, this.props.repository, null)
  }

  public render() {
    return (
      <>
        <button
          // Prevent form submission with this button
          type="button"
          tabIndex={-1}
          className="vertical-resize-handle"
          aria-label="Resize Smart Split panel"
          onMouseDown={this.handleResizeDragStart}
          onDoubleClick={this.handleResizeDoubleClick}
        />
        <div
          className="smart-split-resizable-container"
          style={{ height: this.state.height }}
        >
          <SuggestedCommitList
            suggestions={this.props.suggestions}
            isCommitting={this.props.isCommitting}
            isLoading={this.props.isLoading}
            onSuggestionsUpdated={this.onSuggestionsUpdated}
            onCommitAll={this.onCommitAll}
            onRegenerate={this.onRegenerate}
            onDismiss={this.onDismiss}
            repository={this.props.repository}
          />
        </div>
      </>
    )
  }
}
