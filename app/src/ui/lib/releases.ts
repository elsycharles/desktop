/** Where the releases of this fork are published */
export const ForkReleasesUri = 'https://github.com/elsycharles/desktop/releases'

export const ReleaseNotesUri =
  __RELEASE_CHANNEL__ === 'beta'
    ? 'https://desktop.github.com/release-notes/?env=beta'
    : 'https://desktop.github.com/release-notes/'
