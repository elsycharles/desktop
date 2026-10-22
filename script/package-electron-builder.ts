import * as path from 'path'
import { promisify } from 'util'

import glob = require('glob')
const globPromise = promisify(glob)

import { getDistPath, getDistRoot } from './dist-info'

// electron-builder's type declarations don't compile with this project's
// settings, so it's loaded without them (like the deb and rpm installers).
const { Arch, build, Platform } = require('electron-builder')

function getArchitecture() {
  const arch = process.env.npm_config_arch || process.arch
  switch (arch) {
    case 'arm64':
      return Arch.arm64
    case 'arm':
      return Arch.armv7l
    default:
      return Arch.x64
  }
}

export async function packageElectronBuilder(): Promise<Array<string>> {
  const distPath = getDistPath()
  const distRoot = getDistRoot()

  const configPath = path.resolve(__dirname, 'electron-builder-linux.yml')

  // Use the API rather than the CLI: it reports failures instead of only
  // exiting with an error code, and doesn't depend on the CLI's yargs (which
  // breaks with the string-width version Yarn hoists in this project).
  await build({
    prepackaged: distPath,
    targets: Platform.LINUX.createTarget('AppImage', getArchitecture()),
    config: configPath,
  })

  const appImageInstaller = `${distRoot}/GitHubDesktop-linux-*.AppImage`

  const files = await globPromise(appImageInstaller)
  if (files.length !== 1) {
    return Promise.reject(
      `Expected one AppImage installer but instead found '${files.join(
        ', '
      )}' - exiting...`
    )
  }

  const appImageInstallerPath = files[0]

  return Promise.resolve([appImageInstallerPath])
}
