#!/usr/bin/env node
// Keeps this fork's releases page consistent, for the "Watch upstream
// releases" workflow:
//
// - every release is named after its version, with its platforms when it
//   doesn't have them all: "GitHub Desktop with Smart Split 3.7.1 (Linux)";
// - betas (3.7.1-beta1…) are pre-releases, stable versions aren't;
// - the most recent stable version is the latest release;
// - a release whose every platform a more recent release of the same version
//   has, like the earlier one of a version released again, is deleted with its
//   tag: one release per version is left.
//
// It only changes what differs, so it can run every hour. With
// --keep-duplicates, it only lists the releases it would delete; with
// --dry-run, it only says what it would do.
//
// Usage: node tidy-releases.mjs [--dry-run] [--keep-duplicates]
// Needs gh, with GH_TOKEN allowed to write the repository's contents, and
// GITHUB_REPOSITORY.

import { execFileSync } from 'node:child_process'

const repository = process.env.GITHUB_REPOSITORY
const dryRun = process.argv.includes('--dry-run')
const deleteDuplicates = !process.argv.includes('--keep-duplicates')

if (!repository) {
  throw new Error("GITHUB_REPOSITORY isn't set")
}

function gh(...args) {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 1 << 28 })
}

function act(description, ...args) {
  console.log(`${dryRun ? 'Would ' : ''}${description}`)
  if (!dryRun) {
    gh(...args)
  }
}

/** Like act, but only warns when it fails. */
function tryAct(description, ...args) {
  try {
    act(description, ...args)
  } catch (e) {
    console.log(`::warning::Couldn't ${description}: ${e.stderr ?? e}`)
  }
}

// v3.7.1-smartsplit, v3.6.10-beta1-smartsplit.9, v3.6.10-beta1-linux-smartsplit.7
const tagPattern = /^v(.+?)(-linux)?-smartsplit(\.\d+)?$/

function platformsOf(release) {
  const names = release.assets.map(asset => asset.name)
  return {
    desktop: names.some(n => /\.(zip|exe|msi)$/.test(n)),
    linux: names.some(n => /\.(deb|rpm|AppImage)$/.test(n)),
  }
}

function titleFor(version, { desktop, linux }) {
  const title = `GitHub Desktop with Smart Split ${version}`
  if (desktop && !linux) {
    return `${title} (macOS & Windows)`
  }
  if (linux && !desktop) {
    return `${title} (Linux)`
  }
  return title
}

function main() {
  const releases = JSON.parse(
    gh('api', '--paginate', '--slurp', `repos/${repository}/releases`)
  )
    .flat()
    .filter(release => !release.draft)
    .map(release => {
      const match = tagPattern.exec(release.tag_name)
      return match === null
        ? null
        : {
            ...release,
            version: match[1],
            platforms: platformsOf(release),
            date: Date.parse(release.published_at ?? release.created_at),
          }
    })
    .filter(release => release !== null)
    // Most recent first
    .sort((a, b) => b.date - a.date)

  // Releases of a version that a more recent one makes unnecessary
  const duplicates = new Set()
  for (const release of releases) {
    const newer = releases.filter(
      r => r.version === release.version && r.date > release.date
    )
    const covered = platform =>
      !release.platforms[platform] || newer.some(r => r.platforms[platform])
    if (newer.length > 0 && covered('desktop') && covered('linux')) {
      duplicates.add(release)
    }
  }

  for (const release of releases) {
    if (duplicates.has(release)) {
      if (deleteDuplicates) {
        act(
          `delete ${release.tag_name}, which more recent releases of ${release.version} replace`,
          'api',
          '-X',
          'DELETE',
          `repos/${repository}/releases/${release.id}`
        )
        // The release is what matters: a tag left behind is only noise
        tryAct(
          `delete the tag ${release.tag_name}`,
          'api',
          '-X',
          'DELETE',
          `repos/${repository}/git/refs/tags/${release.tag_name}`
        )
        continue
      }
      console.log(
        `${release.tag_name} is replaced by more recent releases of ${release.version} (run without --keep-duplicates to delete it)`
      )
    }

    const title = titleFor(release.version, release.platforms)
    const prerelease = release.version.includes('-')
    if (release.name !== title || release.prerelease !== prerelease) {
      act(
        `rename ${release.tag_name} "${title}"${
          prerelease ? ', as a pre-release' : ''
        }`,
        'api',
        '-X',
        'PATCH',
        `repos/${repository}/releases/${release.id}`,
        '-f',
        `name=${title}`,
        '-F',
        `prerelease=${prerelease}`
      )
    }
  }

  const latest = releases.find(
    r =>
      !r.version.includes('-') &&
      !(deleteDuplicates && duplicates.has(r)) &&
      r.platforms.desktop
  )
  if (latest !== undefined) {
    const current = JSON.parse(
      gh('api', `repos/${repository}/releases/latest`)
    ).tag_name
    if (current !== latest.tag_name) {
      act(
        `make ${latest.tag_name} the latest release (instead of ${current})`,
        'api',
        '-X',
        'PATCH',
        `repos/${repository}/releases/${latest.id}`,
        '-f',
        'make_latest=true'
      )
    }
  }
}

main()
