import { describe, it } from 'node:test'
import assert from 'node:assert'
import * as path from 'path'
import { writeFile } from 'fs/promises'
import { exec } from 'dugite'

import { Repository } from '../../../src/models/repository'
import { createCommit, getWorkingDirectoryDiff } from '../../../src/lib/git'
import { setupEmptyRepository } from '../../helpers/repositories'
import { getStatusOrThrow } from '../../helpers/status'
import { DiffType, ITextDiff } from '../../../src/models/diff'
import {
  getHunkSignature,
  getSelectionForHunks,
  selectHunksForSuggestion,
} from '../../../src/lib/smart-commit-suggestions'
import { ICommitSuggestion } from '../../../src/models/commit-suggestion'

const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`)

async function getFileAndDiff(repo: Repository) {
  const status = await getStatusOrThrow(repo)
  const [file] = status.workingDirectory.files
  const diff = await getWorkingDirectoryDiff(repo, file)
  assert.equal(diff.kind, DiffType.Text)
  return { file, diff: diff as ITextDiff }
}

async function getHeadContent(repo: Repository) {
  const result = await exec(['show', 'HEAD:file.txt'], repo.path)
  return result.stdout
}

function suggestion(hunks: ReadonlyArray<number>): ICommitSuggestion {
  return {
    summary: 'feat: x',
    description: '',
    files: ['file.txt'],
    hunks: { 'file.txt': hunks },
    enabled: true,
  }
}

describe('Smart Split commits', () => {
  it('commits a file split by hunks across several commits', async t => {
    const repo = await setupEmptyRepository(t)
    const filePath = path.join(repo.path, 'file.txt')

    await writeFile(filePath, lines.join('\n') + '\n')
    await exec(['add', 'file.txt'], repo.path)
    await exec(['commit', '-m', 'Initial commit'], repo.path)

    // Three distant changes, the last one being the last line of the file so
    // that its hunk ends with a changed line (no trailing context).
    const changed = [...lines]
    changed[0] = 'line 1 changed'
    changed[14] = 'line 15 changed'
    changed[29] = 'line 30 changed'
    await writeFile(filePath, changed.join('\n') + '\n')

    const first = suggestion([1, 3])
    const second = suggestion([2])

    const initial = await getFileAndDiff(repo)
    assert.equal(initial.diff.hunks.length, 3)
    const initialSignatures = initial.diff.hunks.map(getHunkSignature)

    const firstHunks = selectHunksForSuggestion(
      'file.txt',
      initial.diff.hunks,
      first,
      [second],
      1,
      initialSignatures
    )
    await createCommit(repo, 'first', [
      initial.file.withSelection(getSelectionForHunks(firstHunks)),
    ])

    const expectedAfterFirst = [...lines]
    expectedAfterFirst[0] = 'line 1 changed'
    expectedAfterFirst[29] = 'line 30 changed'
    assert.equal(
      await getHeadContent(repo),
      expectedAfterFirst.join('\n') + '\n'
    )

    // The remaining hunk is still found from its initial number
    const remaining = await getFileAndDiff(repo)
    assert.equal(remaining.diff.hunks.length, 1)

    const secondHunks = selectHunksForSuggestion(
      'file.txt',
      remaining.diff.hunks,
      second,
      [],
      0,
      initialSignatures
    )
    assert.equal(secondHunks.length, 1)

    await createCommit(repo, 'second', [remaining.file.withIncludeAll(true)])

    assert.equal(await getHeadContent(repo), changed.join('\n') + '\n')
    const status = await getStatusOrThrow(repo)
    assert.equal(status.workingDirectory.files.length, 0)
  })
})
