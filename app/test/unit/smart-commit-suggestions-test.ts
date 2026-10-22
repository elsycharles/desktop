import { describe, it } from 'node:test'
import assert from 'node:assert'
import {
  getHunkSignature,
  normalizeSmartCommitSuggestions,
  parseSmartCommitSuggestions,
  selectHunksForSuggestion,
} from '../../src/lib/smart-commit-suggestions'
import { DiffParser } from '../../src/lib/diff-parser'
import { ICommitSuggestion } from '../../src/models/commit-suggestion'
import { DiffHunk } from '../../src/models/diff'

function suggestion(
  files: ReadonlyArray<string>,
  hunks: ICommitSuggestion['hunks'] = {},
  enabled: boolean = true
): ICommitSuggestion {
  return { summary: 'feat: x', description: '', files, hunks, enabled }
}

/** Parses a diff with one hunk per given added line */
function hunksOf(
  ...addedLines: ReadonlyArray<string>
): ReadonlyArray<DiffHunk> {
  const text = [
    'diff --git a/a.ts b/a.ts',
    'index 1111111..2222222 100644',
    '--- a/a.ts',
    '+++ b/a.ts',
    ...addedLines.flatMap((line, i) => [
      `@@ -${i * 10 + 1},1 +${i * 10 + 1 + i},2 @@`,
      ' context',
      `+${line}`,
    ]),
  ].join('\n')

  return new DiffParser().parse(text).hunks
}

describe('parseSmartCommitSuggestions', () => {
  it('parses a valid response', () => {
    const result = parseSmartCommitSuggestions(
      JSON.stringify({
        suggestions: [
          {
            summary: 'feat(login): add OAuth button',
            description: 'Adds Google OAuth entry point',
            files: ['src/Login.tsx', 'src/auth/oauth.ts'],
          },
          {
            summary: 'fix(logout): fix button not showing',
            description: '',
            files: ['src/Header.tsx'],
          },
        ],
      }),
      ['src/Login.tsx', 'src/auth/oauth.ts', 'src/Header.tsx']
    )

    assert.equal(result.length, 2)
    assert.equal(result[0].summary, 'feat(login): add OAuth button')
    assert.deepEqual(result[1].files, ['src/Header.tsx'])
    assert.deepEqual(result[1].hunks, {})
  })

  it('accepts JSON wrapped in markdown fences', () => {
    const result = parseSmartCommitSuggestions(
      '```json\n{"suggestions":[{"summary":"chore: x","files":["a.ts"]}]}\n```',
      ['a.ts']
    )

    assert.deepEqual(result[0].files, ['a.ts'])
  })

  it('throws on invalid JSON', () => {
    assert.throws(() => parseSmartCommitSuggestions('not json', ['a.ts']))
  })
})

describe('normalizeSmartCommitSuggestions', () => {
  it('adds files missing from every suggestion to the last one', () => {
    const result = normalizeSmartCommitSuggestions(
      {
        suggestions: [
          { summary: 'feat: a', files: ['a.ts'] },
          { summary: 'feat: b', files: ['b.ts'] },
        ],
      },
      ['a.ts', 'b.ts', 'c.ts']
    )

    assert.deepEqual(result[1].files, ['b.ts', 'c.ts'])
  })

  it('drops unknown paths, duplicates and suggestions without files', () => {
    const result = normalizeSmartCommitSuggestions(
      {
        suggestions: [
          { summary: 'feat: a', files: ['a.ts', 'a.ts', 'unknown.ts', 42] },
          { summary: 'feat: nothing', files: ['unknown.ts'] },
        ],
      },
      ['a.ts']
    )

    assert.equal(result.length, 1)
    assert.deepEqual(result[0].files, ['a.ts'])
  })

  it('tolerates ./, a/ and b/ path prefixes', () => {
    const result = normalizeSmartCommitSuggestions(
      {
        suggestions: [
          {
            summary: 'feat: a',
            files: ['./src/a.ts', 'b/src/b.ts'],
            hunks: { 'a/src/a.ts': [2, 1] },
          },
        ],
      },
      ['src/a.ts', 'src/b.ts']
    )

    assert.deepEqual(result[0].files, ['src/a.ts', 'src/b.ts'])
    assert.deepEqual(result[0].hunks, { 'src/a.ts': [1, 2] })
  })

  it('only keeps valid hunk numbers of files in the suggestion', () => {
    const result = normalizeSmartCommitSuggestions(
      {
        suggestions: [
          {
            summary: 'feat: a',
            files: ['a.ts'],
            hunks: { 'a.ts': [3, 0, -1, 1.5, 'x', 3, 1], 'b.ts': [1] },
          },
          { summary: 'feat: b', files: ['b.ts'] },
        ],
      },
      ['a.ts', 'b.ts']
    )

    assert.deepEqual(result[0].hunks, { 'a.ts': [1, 3] })
  })

  it('supports the "title" key instead of "summary"', () => {
    const result = normalizeSmartCommitSuggestions(
      { suggestions: [{ title: ' fix: typo ', files: ['a.ts'] }] },
      ['a.ts']
    )

    assert.equal(result[0].summary, 'fix: typo')
  })

  it('falls back to a single commit message response', () => {
    const result = normalizeSmartCommitSuggestions(
      { title: 'chore: update', description: 'Details' },
      ['a.ts', 'b.ts']
    )

    assert.equal(result.length, 1)
    assert.equal(result[0].summary, 'chore: update')
    assert.deepEqual(result[0].files, ['a.ts', 'b.ts'])
  })

  it('throws on unexpected payloads', () => {
    assert.throws(() => normalizeSmartCommitSuggestions([], ['a.ts']))
    assert.throws(() =>
      normalizeSmartCommitSuggestions({ suggestions: [] }, ['a.ts'])
    )
  })
})

describe('selectHunksForSuggestion', () => {
  const initial = hunksOf('one', 'two', 'three')
  const initialSignatures = initial.map(getHunkSignature)

  it('takes every hunk when no other suggestion has the file', () => {
    const result = selectHunksForSuggestion(
      'a.ts',
      initial,
      suggestion(['a.ts']),
      [],
      0,
      null
    )

    assert.equal(result.length, 3)
  })

  it('takes the hunks assigned by Copilot', () => {
    const result = selectHunksForSuggestion(
      'a.ts',
      initial,
      suggestion(['a.ts'], { 'a.ts': [1, 3] }),
      [suggestion(['a.ts'], { 'a.ts': [2] })],
      1,
      initialSignatures
    )

    assert.deepEqual(result.map(getHunkSignature), ['+one', '+three'])
  })

  it('still finds the assigned hunks after other hunks were committed', () => {
    // Hunk 1 ("one") has already been committed by a previous suggestion
    const remaining = hunksOf('two', 'three')

    const result = selectHunksForSuggestion(
      'a.ts',
      remaining,
      suggestion(['a.ts'], { 'a.ts': [3] }),
      [suggestion(['a.ts'], { 'a.ts': [2] })],
      1,
      initialSignatures
    )

    assert.deepEqual(result.map(getHunkSignature), ['+three'])
  })

  it('leaves the hunks claimed by other suggestions to them', () => {
    const result = selectHunksForSuggestion(
      'a.ts',
      initial,
      suggestion(['a.ts']),
      [suggestion(['a.ts'], { 'a.ts': [2] })],
      1,
      initialSignatures
    )

    assert.deepEqual(result.map(getHunkSignature), ['+one', '+three'])
  })

  it('shares hunks in order when Copilot did not split the file', () => {
    const result = selectHunksForSuggestion(
      'a.ts',
      initial,
      suggestion(['a.ts']),
      [suggestion(['a.ts']), suggestion(['a.ts'])],
      2,
      null
    )

    assert.deepEqual(result.map(getHunkSignature), ['+one'])
  })

  it('takes the whole file when only shared with disabled suggestions', () => {
    const result = selectHunksForSuggestion(
      'a.ts',
      initial,
      suggestion(['a.ts']),
      [suggestion(['a.ts'], {}, false)],
      0,
      null
    )

    assert.equal(result.length, 3)
  })
})
