import { describe, it } from 'node:test'
import assert from 'node:assert'
import {
  annotateDiffHunks,
  buildSmartSplitSystemPrompt,
  buildSmartSplitUserPrompt,
  MaxSmartSplitDiffLength,
} from '../../src/lib/smart-commit-prompt'

describe('buildSmartSplitSystemPrompt', () => {
  it('includes conventional commits format by default', () => {
    const files = ['src/app.ts', 'src/utils.ts']
    const prompt = buildSmartSplitSystemPrompt(files)

    assert(
      prompt.includes('conventional commits'),
      'Prompt should contain conventional commits format'
    )
    assert(
      prompt.includes('type(scope): description'),
      'Prompt should contain format example'
    )
  })

  it('includes all file paths in the prompt', () => {
    const files = ['src/components/Login.tsx', 'src/auth/oauth.ts', 'README.md']
    const prompt = buildSmartSplitSystemPrompt(files)

    for (const file of files) {
      assert(prompt.includes(file), `Prompt should contain file: ${file}`)
    }
  })

  it('instructs the AI to return JSON with suggestions array', () => {
    const prompt = buildSmartSplitSystemPrompt(['a.ts'])

    assert(
      prompt.includes('"suggestions"'),
      'Prompt should mention suggestions key'
    )
    assert(prompt.includes('"summary"'), 'Prompt should mention summary field')
    assert(
      prompt.includes('"description"'),
      'Prompt should mention description field'
    )
    assert(prompt.includes('"files"'), 'Prompt should mention files field')
  })

  it('instructs to not omit files', () => {
    const prompt = buildSmartSplitSystemPrompt(['a.ts', 'b.ts'])

    assert(
      prompt.includes('Every staged file MUST appear at least once'),
      'Prompt should instruct no file omission'
    )
  })

  it('instructs to keep summaries under 72 characters', () => {
    const prompt = buildSmartSplitSystemPrompt(['a.ts'])

    assert(
      prompt.includes('72 characters'),
      'Prompt should mention 72-char limit'
    )
  })

  it('uses custom format when provided', () => {
    const prompt = buildSmartSplitSystemPrompt(['a.ts'], {
      template: 'dev/fix/chore(feature) : description',
    })

    assert(
      prompt.includes('dev/fix/chore(feature) : description'),
      'Prompt should contain the custom format template'
    )
    assert(
      !prompt.includes('conventional commits'),
      'Should NOT include conventional commits when custom format is provided'
    )
    assert(
      prompt.includes('CUSTOM commit format'),
      'Should instruct AI to follow custom format'
    )
    assert(prompt.includes('dev/fix/chore'), 'Should analyze the options group')
  })

  it('analyzes bracket format correctly', () => {
    const prompt = buildSmartSplitSystemPrompt(['a.ts'], {
      template: '[type] [name] (scope) : description',
    })

    assert(prompt.includes('[type]'), 'Should analyze bracketed segments')
    assert(prompt.includes('(scope)'), 'Should analyze parenthesized segments')
    assert(
      prompt.includes('keep the brackets'),
      'Should instruct to keep brackets'
    )
  })

  it('falls back to conventional commits when template is empty', () => {
    const prompt = buildSmartSplitSystemPrompt(['a.ts'], {
      template: '  ',
    })

    assert(
      prompt.includes('conventional commits'),
      'Should fall back to conventional commits for empty template'
    )
  })
})

describe('buildSmartSplitSystemPrompt hunks', () => {
  it('explains the hunk markers and the hunks field', () => {
    const prompt = buildSmartSplitSystemPrompt(['a.ts'])

    assert(prompt.includes('[hunk 2]'), 'Prompt should explain hunk markers')
    assert(prompt.includes('"hunks"'), 'Prompt should mention hunks field')
  })

  it('references the diff tag when provided', () => {
    const prompt = buildSmartSplitSystemPrompt(['a.ts'], undefined, 'diff-x')

    assert(prompt.includes('<diff-x>'), 'Prompt should reference the diff tag')
  })
})

describe('annotateDiffHunks', () => {
  it('numbers hunks from 1 within each file', () => {
    const diff = [
      'diff --git a/a.ts b/a.ts',
      '@@ -1,1 +1,2 @@',
      '+a',
      '@@ -10,1 +11,2 @@',
      '+b',
      'diff --git a/b.ts b/b.ts',
      '@@ -1,1 +1,2 @@',
      '+@@ not a header',
    ].join('\n')

    assert.equal(
      annotateDiffHunks(diff),
      [
        'diff --git a/a.ts b/a.ts',
        '[hunk 1]',
        '@@ -1,1 +1,2 @@',
        '+a',
        '[hunk 2]',
        '@@ -10,1 +11,2 @@',
        '+b',
        'diff --git a/b.ts b/b.ts',
        '[hunk 1]',
        '@@ -1,1 +1,2 @@',
        '+@@ not a header',
      ].join('\n')
    )
  })
})

describe('buildSmartSplitUserPrompt', () => {
  it('wraps the diff in the given tag', () => {
    const prompt = buildSmartSplitUserPrompt('@@ -1 +1 @@', 'diff-x')

    assert(prompt.includes('<diff-x>\n[hunk 1]\n@@ -1 +1 @@\n</diff-x>'))
  })

  it('truncates very large diffs', () => {
    const prompt = buildSmartSplitUserPrompt(
      'x'.repeat(MaxSmartSplitDiffLength * 2)
    )

    assert(prompt.length < MaxSmartSplitDiffLength + 1000)
    assert(prompt.includes('[Diff truncated'))
  })
})
