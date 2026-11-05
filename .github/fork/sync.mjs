#!/usr/bin/env node
// The steps of the "Sync branch" workflow (.github/workflows/sync-branch.yml)
// that merge source branches into a branch of this repository:
//
//   node sync.mjs merge    Merges each source in turn, resolving the conflicts
//                          that don't need a person (see resolve-conflicts.mjs).
//   node sync.mjs format   Formats the files whose conflicts were resolved.
//   node sync.mjs publish  Pushes the merge once it passed the checks. When a
//                          person is needed instead, puts what to do in a pull
//                          request from the sync branch, kept up to date until
//                          it's merged or isn't needed anymore.
//
// The workflow passes its settings in the environment: TARGET_BRANCH, SOURCES
// (one "<owner>/<repository> <branch>" per line), SYNC_BRANCH (the pull
// request's branch), CHECKS (the outcome of each check, as JSON), REPORTED
// (whether this same attempt was already reported) and the tokens. The
// commands share what they found in $RUNNER_TEMP/sync-state.json, and write
// what happened to the job summary.

import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const scripts = dirname(fileURLToPath(import.meta.url))
const temp = process.env.RUNNER_TEMP ?? tmpdir()
const statePath = join(temp, 'sync-state.json')

const target = required('TARGET_BRANCH')
const syncBranch = process.env.SYNC_BRANCH ?? `sync/${target}`
const repository = required('GITHUB_REPOSITORY')
const runUrl = `${
  process.env.GITHUB_SERVER_URL ?? 'https://github.com'
}/${repository}/actions/runs/${process.env.GITHUB_RUN_ID ?? ''}`

function required(name) {
  const value = process.env[name]
  if (!value) {
    throw new Error(`${name} isn't set`)
  }
  return value
}

// Helpers

function git(...args) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    maxBuffer: 1 << 30,
  }).trim()
}

/** Runs git, showing its output, and returns whether it succeeded. */
function tryGit(...args) {
  return spawnSync('git', args, { stdio: 'inherit' }).status === 0
}

function revParse(rev) {
  const result = spawnSync('git', ['rev-parse', '-q', '--verify', rev], {
    encoding: 'utf8',
  })
  return result.status === 0 ? result.stdout.trim() : null
}

function isAncestor(ancestor, descendant) {
  return (
    spawnSync('git', ['merge-base', '--is-ancestor', ancestor, descendant])
      .status === 0
  )
}

const short = sha => sha.slice(0, 10)

function setOutput(name, value) {
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `${name}<<EOF\n${value}\nEOF\n`)
  } else {
    console.log(`output ${name}=${value}`)
  }
}

function summary(markdown) {
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n\n`)
  }
  console.log(markdown)
}

function annotate(level, message) {
  const escaped = message
    .replace(/%/g, '%25')
    .replace(/\r/g, '%0D')
    .replace(/\n/g, '%0A')
  console.log(`::${level}::${escaped}`)
}

function readState() {
  return JSON.parse(readFileSync(statePath, 'utf8'))
}

function writeState(state) {
  writeFileSync(statePath, JSON.stringify(state, null, 2))
}

// merge

function parseSources(text) {
  return text
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      const [repo, branch] = line.split(/\s+/)
      return { repo, branch, label: `${repo}@${branch}` }
    })
}

function remoteFor(source, index) {
  if (source.repo === repository) {
    return 'origin'
  }
  const name = `source-${index + 1}`
  spawnSync('git', ['remote', 'remove', name], { stdio: 'ignore' })
  git('remote', 'add', name, `https://github.com/${source.repo}.git`)
  return name
}

function resolutionsText(resolutions) {
  return resolutions.map(r => `- ${r.path}: ${r.how}`).join('\n')
}

function merge() {
  const sources = parseSources(required('SOURCES'))
  const before = git('rev-parse', 'HEAD')
  const fetched = []
  const merged = []
  let conflict = null

  for (const [index, source] of sources.entries()) {
    git('fetch', '--no-tags', remoteFor(source, index), source.branch)
    const sha = git('rev-parse', 'FETCH_HEAD')
    fetched.push(sha)

    if (isAncestor(sha, 'HEAD')) {
      console.log(`${source.label} (${short(sha)}) is already merged.`)
      continue
    }

    console.log(`Merging ${source.label} (${short(sha)})…`)
    const message = `Merge ${source.label} into ${target}`
    const clean = tryGit(
      '-c',
      'merge.conflictStyle=diff3',
      'merge',
      '--no-commit',
      '-m',
      message,
      sha
    )

    if (clean) {
      // A fast-forward leaves nothing to commit
      if (revParse('MERGE_HEAD') !== null) {
        git('commit', '--no-edit', '--no-verify')
      }
      merged.push({ ...source, sha, resolutions: [] })
      continue
    }

    if (git('diff', '--name-only', '--diff-filter=U') === '') {
      throw new Error(`Merging ${source.label} failed`)
    }

    const reportPath = join(temp, `conflicts-${index + 1}.json`)
    const resolved =
      spawnSync(
        process.execPath,
        [join(scripts, 'resolve-conflicts.mjs'), '--report', reportPath],
        { stdio: 'inherit' }
      ).status === 0
    const report = existsSync(reportPath)
      ? JSON.parse(readFileSync(reportPath, 'utf8'))
      : []

    if (resolved) {
      const messagePath = join(temp, `message-${index + 1}.txt`)
      writeFileSync(
        messagePath,
        `${message}\n\nConflicts resolved automatically:\n\n${resolutionsText(
          report
        )}\n`
      )
      git('commit', '--no-verify', '-F', messagePath)
      merged.push({ ...source, sha, resolutions: report })
    } else {
      git('merge', '--abort')
      conflict = { ...source, sha, files: report.filter(r => !r.resolved) }
      // The sources after this one wait until it's merged
      break
    }
  }

  const head = git('rev-parse', 'HEAD')
  const attempt = createHash('sha256')
    .update([before, ...fetched].join(' '))
    .digest('hex')
    .slice(0, 16)

  writeState({ before, head, attempt, merged, conflict })

  // Lockfiles are left as yarn wrote them
  const resolvedFiles = merged
    .flatMap(m => m.resolutions)
    .filter(r => r.resolved && !r.path.endsWith('yarn.lock'))
    .map(r => r.path)

  setOutput('merged', String(head !== before))
  setOutput('conflict', String(conflict !== null))
  // The cache key remembering that this attempt was reported
  setOutput('report-key', `sync-reported-${target}-${attempt}`)
  setOutput('resolved-files', resolvedFiles.join('\n'))

  const lines = []
  for (const m of merged) {
    lines.push(`- Merged ${m.label} (${short(m.sha)})`)
    for (const r of m.resolutions) {
      lines.push(`  - ${r.path}: ${r.how}`)
    }
  }
  if (conflict) {
    lines.push(`- Couldn't merge ${conflict.label} (${short(conflict.sha)}):`)
    for (const f of conflict.files) {
      lines.push(`  - ${f.path}: ${f.reason}`)
    }
  }
  summary(
    `## Merge into ${target}\n\n${
      lines.length > 0 ? lines.join('\n') : 'Already up to date.'
    }`
  )
}

// format

/** Formats the files whose conflicts were resolved, in the merge commit. */
function format() {
  const files = (process.env.RESOLVED_FILES ?? '')
    .split('\n')
    .map(f => f.trim())
    .filter(Boolean)
  if (files.length === 0) {
    return
  }

  execFileSync(
    join('node_modules', '.bin', 'prettier'),
    ['--write', '--ignore-unknown', '--', ...files],
    { stdio: 'inherit' }
  )

  if (git('status', '--porcelain', '--', ...files) !== '') {
    git('add', '--', ...files)
    git('commit', '--amend', '--no-edit', '--no-verify')
    const state = readState()
    state.head = git('rev-parse', 'HEAD')
    writeState(state)
    console.log('Formatted the files whose conflicts were resolved.')
  }
}

// publish

const stateMarker = /<!-- sync-state (\{.*?\}) -->/

/** The open pull request from the sync branch, with the state it records. */
function findPullRequest() {
  const list = JSON.parse(
    gh([
      'pr',
      'list',
      '--repo',
      repository,
      '--head',
      syncBranch,
      '--base',
      target,
      '--state',
      'open',
      '--json',
      'number,url,headRefOid,body',
    ])
  )
  if (list.length === 0) {
    return null
  }
  const pr = list[0]
  const match = stateMarker.exec(pr.body ?? '')
  return { ...pr, state: match ? JSON.parse(match[1]) : null }
}

const tokens = [process.env.GH_TOKEN, process.env.SYNC_TOKEN].filter(Boolean)

/**
 * Runs gh with GITHUB_TOKEN, then with SYNC_TOKEN if that fails: each may lack
 * a permission the other has (see sync-branch.yml).
 */
function gh(args, { allTokens = false } = {}) {
  let lastError = null
  for (const token of allTokens ? tokens : tokens.slice(0, 1)) {
    try {
      return execFileSync('gh', args, {
        encoding: 'utf8',
        env: { ...process.env, GH_TOKEN: token },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (e) {
      lastError = e
      console.log(`gh ${args.slice(0, 2).join(' ')} failed: ${e.stderr ?? e}`)
    }
  }
  throw lastError
}

function remoteSyncBranch() {
  const line = git('ls-remote', '--heads', 'origin', syncBranch)
  return line === '' ? null : line.split(/\s+/)[0]
}

function deleteSyncBranch() {
  if (remoteSyncBranch() !== null) {
    tryGit('push', 'origin', '--delete', syncBranch)
  }
}

/** Whether someone other than this workflow pushed to the pull request. */
function hasOtherCommits(pr) {
  return pr.state === null || pr.headRefOid !== pr.state.pushed
}

/** Whether the target branch has everything the pull request was for. */
function isObsolete(pr) {
  return (
    pr.state !== null &&
    pr.state.sources.every(sha => {
      if (revParse(`${sha}^{commit}`) === null) {
        spawnSync('git', ['fetch', '--no-tags', 'origin', sha], {
          stdio: 'ignore',
        })
      }
      return (
        revParse(`${sha}^{commit}`) !== null &&
        isAncestor(sha, `origin/${target}`)
      )
    })
  )
}

function closePullRequest(pr, comment) {
  try {
    gh(
      [
        'pr',
        'close',
        String(pr.number),
        '--repo',
        repository,
        '--comment',
        comment,
      ],
      {
        allTokens: true,
      }
    )
    deleteSyncBranch()
    summary(`Closed ${pr.url}, which isn't needed anymore.`)
  } catch {
    annotate('warning', `Couldn't close ${pr.url}, which isn't needed anymore.`)
  }
}

function checkResults() {
  const checks = JSON.parse(process.env.CHECKS ?? '{}')
  return {
    ran: Object.values(checks).some(o => o === 'success' || o === 'failure'),
    failed: Object.entries(checks)
      .filter(([, outcome]) => outcome === 'failure')
      .map(([name]) => name),
  }
}

function pushTarget(state) {
  if (tryGit('push', 'origin', `HEAD:refs/heads/${target}`)) {
    summary(`Pushed ${short(state.head)} to ${target}.`)
    return true
  }
  git('fetch', '--no-tags', 'origin', target)
  if (git('rev-parse', `origin/${target}`) !== state.before) {
    // Someone pushed meanwhile: the next run merges again on top of it
    annotate(
      'warning',
      `${target} changed while the merge was being checked: it will be merged again on the next run.`
    )
    return false
  }
  throw new Error(`Couldn't push to ${target}`)
}

function pullRequestBody(problem, state) {
  const intro =
    problem.kind === 'conflict'
      ? [
          `The sync couldn't merge \`${problem.label}\` (${short(
            problem.sha
          )}) into \`${target}\`: these files changed on both sides in ways it can't combine by itself.`,
          '',
          '| File | Why |',
          '| --- | --- |',
          ...problem.files.map(f => `| \`${f.path}\` | ${f.reason} |`),
          '',
          '### To finish',
          '',
          `Resolve the conflicts, with the **Resolve conflicts** button below or locally, then merge this pull request:`,
          '',
          '```sh',
          'git fetch origin',
          `git switch ${syncBranch}`,
          `git merge origin/${target}`,
          '# resolve the conflicts, then',
          'git commit',
          `git push origin ${syncBranch}`,
          '```',
        ]
      : [
          `The sync merged ${state.merged
            .map(m => `\`${m.label}\` (${short(m.sha)})`)
            .join(
              ' and '
            )} into \`${target}\`, but the merged code doesn't pass these checks, so it wasn't pushed: **${problem.failed.join(
            ', '
          )}**. The details are in [the run](${runUrl}).`,
          '',
          ...(state.merged.some(m => m.resolutions.length > 0)
            ? [
                'Conflicts it resolved by itself in this merge:',
                '',
                ...state.merged.flatMap(m =>
                  m.resolutions.map(r => `- \`${r.path}\`: ${r.how}`)
                ),
                '',
              ]
            : []),
          '### To finish',
          '',
          'Push the fixes to this pull request, then merge it:',
          '',
          '```sh',
          'git fetch origin',
          `git switch ${syncBranch}`,
          '# fix, commit, then',
          `git push origin ${syncBranch}`,
          '```',
        ]

  return [
    ...intro,
    '',
    `Merge it with **Create a merge commit**, not squash or rebase, so that ${target} keeps the history of the branches it merges. The sync then carries on by itself.`,
    '',
    'Until then, the sync keeps this pull request up to date and closes it if it becomes unnecessary, as long as nobody else pushes to it.',
    '',
    `<!-- sync-state ${JSON.stringify({
      pushed: problem.head,
      sources: problem.sources,
    })} -->`,
  ].join('\n')
}

/**
 * Puts what a person has to do in the sync pull request. Returns whether a
 * pull request has it.
 */
function reportProblem(problem, state, pr) {
  const title =
    problem.kind === 'conflict'
      ? `Sync: merge ${problem.label} into ${target} (conflicts)`
      : `Sync: merge into ${target} (failed checks)`

  if (pr !== null && hasOtherCommits(pr)) {
    summary(
      `${
        pr.url
      } has commits from someone else, so the sync leaves it as is: ${title.replace(
        /^Sync: /,
        ''
      )}.`
    )
    return true
  }

  if (
    !tryGit(
      'push',
      '--force',
      'origin',
      `${problem.head}:refs/heads/${syncBranch}`
    )
  ) {
    throw new Error(`Couldn't push ${syncBranch}`)
  }

  const bodyPath = join(temp, 'pull-request.md')
  writeFileSync(bodyPath, pullRequestBody(problem, state))

  try {
    if (pr !== null) {
      gh(
        [
          'pr',
          'edit',
          String(pr.number),
          '--repo',
          repository,
          '--title',
          title,
          '--body-file',
          bodyPath,
        ],
        {
          allTokens: true,
        }
      )
      summary(`Updated ${pr.url}: ${title.replace(/^Sync: /, '')}.`)
    } else {
      const url = gh(
        [
          'pr',
          'create',
          '--repo',
          repository,
          '--base',
          target,
          '--head',
          syncBranch,
          '--title',
          title,
          '--body-file',
          bodyPath,
        ],
        { allTokens: true }
      ).trim()
      summary(`Opened ${url}: ${title.replace(/^Sync: /, '')}.`)
      annotate('warning', `A person is needed to finish the sync: ${url}`)
    }
    return true
  } catch {
    const compare = `https://github.com/${repository}/compare/${target}...${syncBranch}`
    summary(
      `**A person is needed, but no pull request could be opened.** It's on the \`${syncBranch}\` branch: ${compare}\n\n${readFileSync(
        bodyPath,
        'utf8'
      )}`
    )
    return false
  }
}

function publish() {
  const state = readState()
  const merged = state.head !== state.before
  const reported = process.env.REPORTED === 'true'
  let pr = findPullRequest()

  if (reported) {
    summary(
      `Nothing changed since this was last reported${
        pr ? `, in ${pr.url}` : ''
      }: the sync tries again once ${target} or a source changes.`
    )
    return
  }

  const checks = checkResults()
  let updated = false
  let problem = null

  if (merged && checks.ran && checks.failed.length === 0) {
    updated = pushTarget(state)
  } else if (merged) {
    problem = {
      kind: 'checks',
      head: state.head,
      failed:
        checks.failed.length > 0 ? checks.failed : ["the checks didn't run"],
      sources: state.merged.map(m => m.sha),
    }
  }
  setOutput('updated', String(updated))

  if (problem === null && state.conflict !== null) {
    const { label, sha, files } = state.conflict
    problem = { kind: 'conflict', head: sha, label, sha, files, sources: [sha] }
  }

  if (problem === null) {
    // Tidy up what's no longer needed
    if (pr !== null && !hasOtherCommits(pr) && isObsolete(pr)) {
      closePullRequest(
        pr,
        `${target} has everything this pull request was for now, so the sync closed it.`
      )
    } else if (pr === null) {
      const branch = remoteSyncBranch()
      if (branch !== null) {
        git('fetch', '--no-tags', 'origin', branch)
        if (
          isAncestor(branch, `origin/${target}`) ||
          isAncestor(branch, 'HEAD')
        ) {
          deleteSyncBranch()
        }
      }
    }
    return
  }

  setOutput('remember', 'true')
  if (!reportProblem(problem, state, pr)) {
    setOutput('unreported', 'true')
  }
}

const commands = { merge, format, publish }
const command = commands[process.argv[2]]
if (command === undefined) {
  console.error(`Usage: node sync.mjs ${Object.keys(commands).join('|')}`)
  process.exit(2)
}
command()
