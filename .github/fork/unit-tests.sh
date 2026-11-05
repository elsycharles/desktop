#!/usr/bin/env bash
# Runs the unit tests the way this fork's workflows do. Arguments are passed on
# to `yarn test:unit`.
#
# - A test that hangs fails after two minutes, with its name in the log, rather
#   than running into the job's timeout; and a test file that leaves handles
#   open can't keep the run from finishing.
# - On Linux, which upstream doesn't run its tests on, the tests run in a
#   virtual display, and the upstream tests listed below are skipped. Keeping
#   them here rather than changing upstream's test files means merging
#   upstream never conflicts over them.

set -euo pipefail

args=(--test-timeout=120000 --test-force-exit)
run=(yarn test:unit)

if [ "$(uname -s)" = "Linux" ]; then
  # Upstream tests that fail on Linux because of the test itself, not of the
  # app, matched by their exact names.
  linux_skips=(
    # Adds the worktree as a repository of its own before switching to it. On
    # macOS the switch doesn't find that repository, since Git reports the
    # temporary directory's real path (/private/var rather than /var), and the
    # test passes; on Linux it selects it, and as it has no GitHub repository,
    # changing its account fails with "The selected repository account is not
    # signed in".
    'uses the current account after switching back to a worktree'
  )

  for name in "${linux_skips[@]}"; do
    pattern=$(printf '%s' "$name" | sed 's/[][\.*^$?+(){}|/]/\\&/g')
    args+=("--test-skip-pattern=^${pattern}\$")
  done

  if [ -z "${DISPLAY:-}" ]; then
    run=(xvfb-run -a "${run[@]}")
  fi
fi

exec "${run[@]}" "${args[@]}" "$@"
