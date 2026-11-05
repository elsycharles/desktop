#!/usr/bin/env node
// Resolves the conflicts of the merge in progress that don't need a person,
// and stages them:
//
// - yarn.lock files are merged by yarn, which combines both versions of the
//   lockfile and settles the result against the merged package.json.
// - A conflict where both sides only added lines at the same place, without
//   changing or removing any line, keeps both additions: ours, then theirs.
//   Typically two sets of imports, class members or tests added at the same
//   spot.
//
// Every other conflict is left as is for a person. The conflicts must be
// written in the diff3 style (merge.conflictStyle=diff3), which shows the
// original lines of each conflict.
//
// Prints what was resolved and what wasn't, writes it as JSON to the file
// given with --report, and exits with 0 when every conflict was resolved, 1
// otherwise.
//
// Usage: node resolve-conflicts.mjs [--report <file>]

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'

// Paths are never pathspecs, whatever characters they contain
const gitEnv = { ...process.env, GIT_LITERAL_PATHSPECS: '1' }

function git(...args) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    env: gitEnv,
    maxBuffer: 1 << 30,
  })
}

function unmergedPaths() {
  return git('diff', '--name-only', '--diff-filter=U', '-z')
    .split('\0')
    .filter(Boolean)
}

/** The index stages of a conflicted path: 1 base, 2 ours, 3 theirs. */
function stagesOf(path) {
  return new Set(
    git('ls-files', '--unmerged', '-z', '--', path)
      .split('\0')
      .filter(Boolean)
      .map(entry => Number(entry.split('\t')[0].split(' ')[2]))
  )
}

const Marker = {
  start: '<<<<<<< ',
  base: '||||||| ',
  separator: '=======',
  end: '>>>>>>> ',
}

/**
 * Splits a file with diff3 conflict markers into text and conflicts. Returns
 * null when the markers aren't the ones expected.
 */
function parseConflicts(lines) {
  const parts = []
  let text = []
  let conflict = null
  let section = null

  for (const line of lines) {
    const bare = line.endsWith('\r') ? line.slice(0, -1) : line

    if (bare.startsWith(Marker.start)) {
      if (conflict !== null) {
        return null
      }
      parts.push({ text })
      text = []
      conflict = { ours: [], base: [], theirs: [] }
      section = 'ours'
    } else if (conflict !== null && bare.startsWith(Marker.base)) {
      if (section !== 'ours') {
        return null
      }
      section = 'base'
    } else if (conflict !== null && bare === Marker.separator) {
      // Without the original lines, nothing says what each side changed
      if (section !== 'base') {
        return null
      }
      section = 'theirs'
    } else if (conflict !== null && bare.startsWith(Marker.end)) {
      if (section !== 'theirs') {
        return null
      }
      parts.push({ conflict })
      conflict = null
      section = null
    } else if (conflict !== null) {
      conflict[section].push(line)
    } else {
      text.push(line)
    }
  }

  if (conflict !== null) {
    return null
  }
  parts.push({ text })
  return parts
}

function sameLines(a, b) {
  return a.length === b.length && a.every((line, i) => line === b[i])
}

/** Whether `inner` appears in `outer` as consecutive lines. */
function containsLines(outer, inner) {
  for (let start = 0; start + inner.length <= outer.length; start++) {
    if (inner.every((line, i) => outer[start + i] === line)) {
      return true
    }
  }
  return false
}

const isBlank = line => line.trim() === ''

/**
 * Both sides added lines at the same place: keep both additions, ours first.
 * When one side added lines the other also added, they're kept once.
 */
function keepBothAdditions({ ours, theirs }) {
  if (containsLines(ours, theirs)) {
    return ours
  }
  if (containsLines(theirs, ours)) {
    return theirs
  }
  // Don't put two blank lines where the additions meet
  if (
    ours.length > 0 &&
    theirs.length > 0 &&
    isBlank(ours[ours.length - 1]) &&
    isBlank(theirs[0])
  ) {
    return [...ours, ...theirs.slice(1)]
  }
  return [...ours, ...theirs]
}

/** Resolves a text file's conflicts, or returns why it can't. */
function resolveText(path) {
  const content = readFileSync(path, 'utf8')
  const parts = parseConflicts(content.split('\n'))
  if (parts === null) {
    return { resolved: false, reason: 'unexpected conflict markers' }
  }

  const conflicts = parts.filter(part => part.conflict)
  if (conflicts.length === 0) {
    return { resolved: false, reason: 'no conflict markers' }
  }
  const changed = conflicts.filter(({ conflict }) => conflict.base.length > 0)
  if (changed.length > 0) {
    return {
      resolved: false,
      reason: `both sides changed the same lines (${changed.length} of ${conflicts.length} conflicts)`,
    }
  }

  const lines = parts.flatMap(part =>
    part.conflict ? keepBothAdditions(part.conflict) : part.text
  )
  const result = lines.join('\n')

  if (path.endsWith('.json')) {
    try {
      JSON.parse(result)
    } catch {
      return {
        resolved: false,
        reason: 'keeping both additions breaks the JSON',
      }
    }
  }

  writeFileSync(path, result)
  git('add', '--', path)
  return {
    resolved: true,
    how: `kept both sides' additions (${conflicts.length} ${
      conflicts.length === 1 ? 'conflict' : 'conflicts'
    })`,
  }
}

function runYarn(cwd) {
  // The packages are installed out of the way, without running their scripts:
  // only the lockfile is wanted, and the real install must still build them
  const modules = mkdtempSync(join(tmpdir(), 'resolve-conflicts-'))
  const args = [
    'install',
    '--ignore-scripts',
    '--non-interactive',
    '--modules-folder',
    modules,
  ]
  try {
    // The registry can fail now and then: try again once
    for (let attempt = 1; ; attempt++) {
      try {
        execFileSync('yarn', args, { cwd, stdio: 'inherit' })
        return
      } catch (e) {
        if (attempt === 2) {
          throw e
        }
        console.log('yarn failed, trying again…')
      }
    }
  } finally {
    rmSync(modules, { recursive: true, force: true })
  }
}

/** Merges a yarn.lock with yarn, once the package.json next to it is merged. */
function resolveLockfile(path) {
  const cwd = dirname(path) || '.'

  // yarn reads the two sides of a conflicted lockfile, but only in the
  // default conflict style
  git('checkout', '--conflict=merge', '--', path)
  try {
    runYarn(cwd)
  } catch {
    // yarn couldn't combine them: start from the incoming lockfile instead,
    // and let yarn bring it in line with the merged package.json
    try {
      git('checkout', '--theirs', '--', path)
      runYarn(cwd)
    } catch {
      return { resolved: false, reason: 'yarn could not merge it' }
    }
  }

  if (/^(<<<<<<<|=======|>>>>>>>)/m.test(readFileSync(path, 'utf8'))) {
    return { resolved: false, reason: 'yarn left conflict markers in it' }
  }
  git('add', '--', path)
  return { resolved: true, how: 'merged by yarn' }
}

function main() {
  const reportIndex = process.argv.indexOf('--report')
  const reportPath = reportIndex === -1 ? null : process.argv[reportIndex + 1]

  const results = []
  const lockfiles = []

  for (const path of unmergedPaths()) {
    const stages = stagesOf(path)
    const bothChanged = stages.has(1) && stages.has(2) && stages.has(3)

    if (!bothChanged) {
      const reason = !stages.has(1)
        ? 'added on both sides'
        : 'deleted on one side and changed on the other'
      results.push({ path, resolved: false, reason })
    } else if (basename(path) === 'yarn.lock') {
      lockfiles.push(path)
    } else {
      results.push({ path, ...resolveText(path) })
    }
  }

  // Lockfiles are settled against the package.json files, so once those are
  // merged, and only if everything else could be
  for (const path of lockfiles) {
    if (results.every(r => r.resolved)) {
      results.push({ path, ...resolveLockfile(path) })
    } else {
      results.push({ path, resolved: false, reason: 'other conflicts remain' })
    }
  }

  for (const r of results) {
    console.log(`${r.resolved ? '✔' : '✖'} ${r.path}: ${r.how ?? r.reason}`)
  }
  if (reportPath) {
    writeFileSync(reportPath, JSON.stringify(results, null, 2))
  }
  process.exit(results.every(r => r.resolved) ? 0 : 1)
}

main()
