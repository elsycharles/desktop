import * as React from 'react'
import { ICommitSuggestion } from '../../models/commit-suggestion'
import { ICommitFormatConfig } from '../../lib/smart-commit-prompt'
import { Button } from '../lib/button'
import { Loading } from '../lib/loading'
import { Octicon } from '../octicons'
import * as octicons from '../octicons/octicons.generated'
import { Repository } from '../../models/repository'
import { TextBox } from '../lib/text-box'

const FormatStorageKeyPrefix = 'smart-split-format-'

function getFormatStorageKey(repository: Repository): string {
  return `${FormatStorageKeyPrefix}${repository.id}`
}

export function loadSavedFormat(repository: Repository): ICommitFormatConfig {
  try {
    const raw = localStorage.getItem(getFormatStorageKey(repository))
    if (raw) {
      const parsed = JSON.parse(raw)
      return {
        template: typeof parsed.template === 'string' ? parsed.template : '',
      }
    }
  } catch {
    // ignore parse errors
  }
  return { template: '' }
}

function saveFormat(repository: Repository, config: ICommitFormatConfig): void {
  try {
    localStorage.setItem(
      getFormatStorageKey(repository),
      JSON.stringify(config)
    )
  } catch {
    // ignore quota errors
  }
}

interface ISuggestedCommitCardProps {
  readonly index: number
  readonly suggestion: ICommitSuggestion
  /** The summary to display (which may be a local, unsaved edit) */
  readonly summary: string
  /** The description to display (which may be a local, unsaved edit) */
  readonly description: string
  readonly isExpanded: boolean
  readonly isFirst: boolean
  readonly isLast: boolean
  readonly isBusy: boolean
  readonly onToggleEnabled: (index: number) => void
  readonly onSummaryChanged: (index: number, value: string) => void
  readonly onSummaryBlur: (index: number) => void
  readonly onDescriptionChanged: (index: number, value: string) => void
  readonly onDescriptionBlur: (index: number) => void
  readonly onMoveUp: (index: number) => void
  readonly onMoveDown: (index: number) => void
  readonly onToggleExpanded: (index: number) => void
}

/** A single editable suggestion of the Smart Split list */
class SuggestedCommitCard extends React.Component<ISuggestedCommitCardProps> {
  private onToggleEnabled = () => this.props.onToggleEnabled(this.props.index)

  private onSummaryChanged = (value: string) =>
    this.props.onSummaryChanged(this.props.index, value)

  private onSummaryBlur = () => this.props.onSummaryBlur(this.props.index)

  private onDescriptionChanged = (e: React.ChangeEvent<HTMLTextAreaElement>) =>
    this.props.onDescriptionChanged(this.props.index, e.currentTarget.value)

  private onDescriptionBlur = () =>
    this.props.onDescriptionBlur(this.props.index)

  private onMoveUp = () => this.props.onMoveUp(this.props.index)

  private onMoveDown = () => this.props.onMoveDown(this.props.index)

  private onToggleExpanded = () => this.props.onToggleExpanded(this.props.index)

  public render() {
    const { suggestion, isExpanded, isFirst, isLast, isBusy } = this.props
    const cardClassName = `suggested-commit-card${
      suggestion.enabled ? '' : ' disabled'
    }`

    return (
      <div className={cardClassName}>
        <div className="suggested-commit-card-header">
          <label className="suggested-commit-toggle">
            <input
              type="checkbox"
              checked={suggestion.enabled}
              onChange={this.onToggleEnabled}
              disabled={isBusy}
              aria-label="Include this commit"
            />
          </label>
          <TextBox
            className="suggested-commit-summary"
            value={this.props.summary}
            onValueChanged={this.onSummaryChanged}
            onBlur={this.onSummaryBlur}
            placeholder="Commit summary"
            disabled={!suggestion.enabled || isBusy}
          />
          <div className="suggested-commit-reorder">
            <button
              className="reorder-btn"
              onClick={this.onMoveUp}
              disabled={isFirst || isBusy}
              aria-label="Move up"
            >
              <Octicon symbol={octicons.chevronUp} />
            </button>
            <button
              className="reorder-btn"
              onClick={this.onMoveDown}
              disabled={isLast || isBusy}
              aria-label="Move down"
            >
              <Octicon symbol={octicons.chevronDown} />
            </button>
          </div>
        </div>

        <button
          className={`suggested-commit-expand-toggle${
            isExpanded ? ' expanded' : ''
          }`}
          onClick={this.onToggleExpanded}
          disabled={isBusy}
          aria-label={
            isExpanded ? 'Collapse description' : 'Expand description'
          }
          aria-expanded={isExpanded}
        >
          <Octicon
            symbol={isExpanded ? octicons.chevronDown : octicons.chevronRight}
          />
          <span className="expand-label">Description</span>
        </button>

        {isExpanded && (
          <textarea
            className="suggested-commit-description"
            value={this.props.description}
            onChange={this.onDescriptionChanged}
            onBlur={this.onDescriptionBlur}
            placeholder="Optional description"
            disabled={!suggestion.enabled || isBusy}
            rows={3}
          />
        )}

        <div className="suggested-commit-files">
          {suggestion.files.map(file => {
            const hunks = suggestion.hunks[file]
            return (
              <span className="suggested-commit-file" key={file}>
                <Octicon symbol={octicons.file} />
                {file}
                {hunks !== undefined && (
                  <span className="suggested-commit-file-hunks">
                    {` · hunk${hunks.length !== 1 ? 's' : ''} ${hunks.join(
                      ', '
                    )}`}
                  </span>
                )}
              </span>
            )
          })}
        </div>
      </div>
    )
  }
}

interface ISuggestedCommitListProps {
  readonly suggestions: ReadonlyArray<ICommitSuggestion>
  readonly isCommitting: boolean
  /** Whether new suggestions are currently being generated */
  readonly isLoading: boolean
  readonly repository: Repository
  readonly onSuggestionsUpdated: (
    suggestions: ReadonlyArray<ICommitSuggestion>
  ) => void
  readonly onCommitAll: () => void
  readonly onRegenerate: (formatConfig?: ICommitFormatConfig) => void
  readonly onDismiss: () => void
}

interface ISuggestedCommitListState {
  /** Index of the suggestion whose description is expanded, or -1 */
  readonly expandedIndex: number
  /**
   * Local editing copies of summaries, keyed by index.
   * While the user is typing, we store the value locally to avoid
   * cursor-jump caused by the async store round-trip.
   */
  readonly editingSummaries: ReadonlyMap<number, string>
  readonly editingDescriptions: ReadonlyMap<number, string>
  /** Whether the format configuration panel is expanded */
  readonly formatPanelOpen: boolean
  /** The user's custom format template */
  readonly formatTemplate: string
}

/**
 * Renders a list of AI-suggested commits, each editable, toggleable,
 * and reorderable. Used for the smart commit split feature.
 */
export class SuggestedCommitList extends React.Component<
  ISuggestedCommitListProps,
  ISuggestedCommitListState
> {
  public constructor(props: ISuggestedCommitListProps) {
    super(props)
    const saved = loadSavedFormat(props.repository)
    this.state = {
      expandedIndex: -1,
      editingSummaries: new Map(),
      editingDescriptions: new Map(),
      formatPanelOpen: false,
      formatTemplate: saved.template,
    }
  }

  private onToggleEnabled = (index: number) => {
    const updated = this.props.suggestions.map((s, i) =>
      i === index ? { ...s, enabled: !s.enabled } : s
    )
    this.props.onSuggestionsUpdated(updated)
  }

  private onSummaryChanged = (index: number, value: string) => {
    this.setState(prev => {
      const next = new Map(prev.editingSummaries)
      next.set(index, value)
      return { editingSummaries: next }
    })
  }

  private onSummaryBlur = (index: number) => {
    const localValue = this.state.editingSummaries.get(index)
    if (localValue === undefined) {
      return
    }

    // Clear local state first
    this.setState(prev => {
      const next = new Map(prev.editingSummaries)
      next.delete(index)
      return { editingSummaries: next }
    })

    // Flush to store
    const suggestion = this.props.suggestions[index]
    if (suggestion && suggestion.summary !== localValue) {
      const updated = this.props.suggestions.map((s, i) =>
        i === index ? { ...s, summary: localValue } : s
      )
      this.props.onSuggestionsUpdated(updated)
    }
  }

  private onDescriptionChanged = (index: number, value: string) => {
    this.setState(prev => {
      const next = new Map(prev.editingDescriptions)
      next.set(index, value)
      return { editingDescriptions: next }
    })
  }

  private onDescriptionBlur = (index: number) => {
    const localValue = this.state.editingDescriptions.get(index)
    if (localValue === undefined) {
      return
    }

    // Clear local state first
    this.setState(prev => {
      const next = new Map(prev.editingDescriptions)
      next.delete(index)
      return { editingDescriptions: next }
    })

    // Flush to store
    const suggestion = this.props.suggestions[index]
    if (suggestion && suggestion.description !== localValue) {
      const updated = this.props.suggestions.map((s, i) =>
        i === index ? { ...s, description: localValue } : s
      )
      this.props.onSuggestionsUpdated(updated)
    }
  }

  private onMoveUp = (index: number) => {
    if (index <= 0) {
      return
    }
    const items = [...this.props.suggestions]
    const temp = items[index - 1]
    items[index - 1] = items[index]
    items[index] = temp
    this.props.onSuggestionsUpdated(items)
  }

  private onMoveDown = (index: number) => {
    if (index >= this.props.suggestions.length - 1) {
      return
    }
    const items = [...this.props.suggestions]
    const temp = items[index + 1]
    items[index + 1] = items[index]
    items[index] = temp
    this.props.onSuggestionsUpdated(items)
  }

  private onToggleExpanded = (index: number) => {
    this.setState(prev => ({
      expandedIndex: prev.expandedIndex === index ? -1 : index,
    }))
  }

  private onCommitAll = () => {
    this.props.onCommitAll()
  }

  private onToggleFormatPanel = () => {
    this.setState(prev => ({ formatPanelOpen: !prev.formatPanelOpen }))
  }

  private onFormatTemplateChanged = (value: string) => {
    this.setState({ formatTemplate: value })
    saveFormat(this.props.repository, {
      template: value,
    })
  }

  private onRegenerate = () => {
    const { formatTemplate } = this.state
    const hasCustomFormat = formatTemplate.trim().length > 0
    this.props.onRegenerate(
      hasCustomFormat ? { template: formatTemplate } : undefined
    )
  }

  private renderFormatPanel(): JSX.Element | null {
    if (!this.state.formatPanelOpen) {
      return null
    }

    const isBusy = this.props.isCommitting || this.props.isLoading

    return (
      <div className="smart-split-format-panel">
        <TextBox
          className="format-template-input"
          value={this.state.formatTemplate}
          onValueChanged={this.onFormatTemplateChanged}
          disabled={isBusy}
          placeholder="Commit format"
        />
      </div>
    )
  }

  public render() {
    const { suggestions, isCommitting, isLoading } = this.props
    const enabledCount = suggestions.filter(s => s.enabled).length
    const hasEmptySummary = suggestions.some(
      (s, i) =>
        s.enabled &&
        (this.state.editingSummaries.get(i) ?? s.summary).trim().length === 0
    )
    const isBusy = isCommitting || isLoading
    const hasCustomFormat = this.state.formatTemplate.trim().length > 0

    const cardsClassName = ['suggested-commit-cards', isBusy ? 'busy' : '']
      .filter(Boolean)
      .join(' ')

    const loading = isBusy ? <Loading /> : undefined
    const buttonText = isCommitting
      ? 'Committing…'
      : isLoading
      ? 'Generating…'
      : `Commit ${enabledCount} change${enabledCount !== 1 ? 's' : ''}`

    const formatToggleClassName = [
      'format-toggle-button',
      this.state.formatPanelOpen ? 'open' : '',
      hasCustomFormat ? 'has-format' : '',
    ]
      .filter(Boolean)
      .join(' ')

    return (
      <div className="suggested-commit-list">
        <div className="suggested-commit-list-header">
          <h3>
            <Octicon symbol={octicons.copilot} />
            Smart Split
          </h3>
          <div className="header-actions">
            <button
              className={formatToggleClassName}
              onClick={this.onToggleFormatPanel}
              disabled={isBusy}
              aria-label={
                hasCustomFormat
                  ? 'Custom format active — click to edit'
                  : 'Configure commit format'
              }
              aria-expanded={this.state.formatPanelOpen}
            >
              <Octicon symbol={octicons.pencil} />
              <span>Format</span>
              {hasCustomFormat && <span className="format-dot" />}
            </button>
            <span className="suggestion-count">
              {enabledCount}/{suggestions.length} selected
            </span>
          </div>
        </div>

        {this.renderFormatPanel()}

        <div className={cardsClassName}>
          {suggestions.map((s, i) => (
            <SuggestedCommitCard
              key={i}
              index={i}
              suggestion={s}
              summary={this.state.editingSummaries.get(i) ?? s.summary}
              description={
                this.state.editingDescriptions.get(i) ?? s.description
              }
              isExpanded={this.state.expandedIndex === i}
              isFirst={i === 0}
              isLast={i === suggestions.length - 1}
              isBusy={isBusy}
              onToggleEnabled={this.onToggleEnabled}
              onSummaryChanged={this.onSummaryChanged}
              onSummaryBlur={this.onSummaryBlur}
              onDescriptionChanged={this.onDescriptionChanged}
              onDescriptionBlur={this.onDescriptionBlur}
              onMoveUp={this.onMoveUp}
              onMoveDown={this.onMoveDown}
              onToggleExpanded={this.onToggleExpanded}
            />
          ))}
        </div>

        <div className="suggested-commit-list-actions">
          <Button
            className="commit-all-button"
            type="submit"
            disabled={enabledCount === 0 || hasEmptySummary || isBusy}
            tooltip={
              hasEmptySummary
                ? 'Every selected commit needs a summary'
                : undefined
            }
            onClick={this.onCommitAll}
          >
            <>
              {loading}
              {buttonText}
            </>
          </Button>
          <Button
            className="regenerate-button"
            disabled={isBusy}
            onClick={this.onRegenerate}
            tooltip="Regenerate suggestions"
          >
            <Octicon symbol={octicons.sync} />
          </Button>
          <Button
            className="dismiss-button"
            disabled={isBusy}
            onClick={this.props.onDismiss}
            tooltip="Dismiss suggestions"
          >
            <Octicon symbol={octicons.x} />
          </Button>
        </div>
      </div>
    )
  }
}
