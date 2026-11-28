#!/usr/bin/env node
// Resolves the conflicts of the merge in progress that don't need a person,
// and stages them:
//
// - A file one side didn't change since one of the merge bases takes the
//   other side's version. Git can report such a conflict when the branches
//   have several merge bases, as upstream's release branches cause: it then
//   merges from a combination of them, in which the file conflicts.
// - package-lock.json files take the incoming version, which npm then
//   settles against the merged package.json.
// - A conflict where both sides only added lines at the same place, without
//   changing or removing any line, keeps both additions: ours, then theirs.
//   Typically two sets of imports, class members or tests added at the same
//   spot.
// - A conflict where one side only added lines before or after lines the
//   other side changed keeps the change and the additions. Typically a
//   dependency upgraded next to one this fork added.
// - The other conflicts of Markdown files keep our text: documentation
//   doesn't affect the app, and this fork's documentation is its own.
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
import { readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname } from 'node:path'

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
  return new Map(
    git('ls-files', '--unmerged', '-z', '--', path)
      .split('\0')
      .filter(Boolean)
      .map(entry => {
        const [mode, object, stage] = entry.split('\t')[0].split(' ')
        return [Number(stage), { mode, object }]
      })
  )
}

/** The commits the merge in progress is based on. */
function mergeBases() {
  return git('merge-base', '--all', 'HEAD', 'MERGE_HEAD')
    .split('\n')
    .filter(Boolean)
}

/** The path's object in each merge base that has it. */
function baseObjects(bases, path) {
  return new Set(
    bases
      .map(base => {
        try {
          return git('rev-parse', '-q', '--verify', `${base}:${path}`).trim()
        } catch {
          return null
        }
      })
      .filter(Boolean)
  )
}

/** Takes one side's version when the other side didn't change the file. */
function resolveUnchangedSide(path, stages, bases) {
  const objects = baseObjects(bases, path)
  for (const [unchanged, side, other] of [
    [2, 'theirs', 'ours'],
    [3, 'ours', 'theirs'],
  ]) {
    if (objects.has(stages.get(unchanged).object)) {
      git('checkout', `--${side}`, '--', path)
      git('add', '--', path)
      return {
        resolved: true,
        how: `took ${side}, as ${other} didn't change it since a merge base`,
      }
    }
  }
  return null
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

/**
 * One side only added lines before or after the original ones, which the
 * other side changed: keep that change, with the additions around it.
 */
function keepChangeAndAdditions({ ours, base, theirs }) {
  for (const [added, changed] of [
    [ours, theirs],
    [theirs, ours],
  ]) {
    if (added.length <= base.length) {
      continue
    }
    const extra = added.length - base.length
    if (sameLines(added.slice(0, base.length), base)) {
      return [...changed, ...added.slice(base.length)]
    }
    if (sameLines(added.slice(extra), base)) {
      return [...added.slice(0, extra), ...changed]
    }
  }
  return null
}

/** How to resolve a conflict, or null when a person has to. */
function resolveConflict(conflict, markdown) {
  if (conflict.base.length === 0) {
    return keepBothAdditions(conflict)
  }
  return keepChangeAndAdditions(conflict) ?? (markdown ? conflict.ours : null)
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
  const markdown = /\.(md|markdown)$/i.test(path)
  const resolutions = conflicts.map(({ conflict }) =>
    resolveConflict(conflict, markdown)
  )
  const unresolved = resolutions.filter(r => r === null).length
  if (unresolved > 0) {
    return {
      resolved: false,
      reason: `both sides changed the same lines (${unresolved} of ${conflicts.length} conflicts)`,
    }
  }

  let next = 0
  const lines = parts.flatMap(part =>
    part.conflict ? resolutions[next++] : part.text
  )
  const result = lines.join('\n')

  if (path.endsWith('.json')) {
    try {
      JSON.parse(result)
    } catch {
      return {
        resolved: false,
        reason: 'combining both sides breaks the JSON',
      }
    }
  }

  writeFileSync(path, result)
  git('add', '--', path)
  return {
    resolved: true,
    how: `combined both sides (${conflicts.length} ${
      conflicts.length === 1 ? 'conflict' : 'conflicts'
    })`,
  }
}

function runNpm(cwd) {
  // Only the lockfile is written: no packages are installed, so the real
  // install still builds them
  const args = ['install', '--package-lock-only', '--ignore-scripts']
  // The registry can fail now and then: try again once
  for (let attempt = 1; ; attempt++) {
    try {
      execFileSync('npm', args, { cwd, stdio: 'inherit' })
      return
    } catch (e) {
      if (attempt === 2) {
        throw e
      }
      console.log('npm failed, trying again…')
    }
  }
}

/**
 * Settles a package-lock.json with npm, once the package.json next to it is
 * merged: from the incoming lockfile, whose versions (security updates
 * included) win, npm adds or removes what the merged package.json needs.
 */
function resolveLockfile(path) {
  git('checkout', '--theirs', '--', path)
  try {
    runNpm(dirname(path) || '.')
  } catch {
    return { resolved: false, reason: 'npm could not settle it' }
  }
  git('add', '--', path)
  return {
    resolved: true,
    how: 'took theirs, then npm settled it against the merged package.json',
  }
}

function main() {
  const reportIndex = process.argv.indexOf('--report')
  const reportPath = reportIndex === -1 ? null : process.argv[reportIndex + 1]

  const results = []
  const lockfiles = []
  const bases = mergeBases()

  for (const path of unmergedPaths()) {
    const stages = stagesOf(path)
    const bothChanged = stages.has(1) && stages.has(2) && stages.has(3)
    const unchangedSide = bothChanged
      ? resolveUnchangedSide(path, stages, bases)
      : null

    if (unchangedSide !== null) {
      results.push({ path, ...unchangedSide })
    } else if (!bothChanged) {
      const reason = !stages.has(1)
        ? 'added on both sides'
        : 'deleted on one side and changed on the other'
      results.push({ path, resolved: false, reason })
    } else if (basename(path) === 'package-lock.json') {
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
