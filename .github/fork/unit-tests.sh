#!/usr/bin/env bash
# Runs the unit tests the way this fork's workflows do. Arguments are passed on
# to `npm run test:unit`.
#
# - A test that hangs fails after two minutes, with its name in the log, rather
#   than running into the job's timeout; and a test file that leaves handles
#   open can't keep the run from finishing.
# - A test file still running after 5 minutes is named in a warning
#   annotation, and stopped after 12: a file can hang outside of its tests,
#   where the time limit of each test doesn't apply. Annotations show on the
#   run's page, and through the API without signing in, unlike the log.
# - On Linux, which upstream doesn't run its tests on, the tests run in a
#   virtual display, and the upstream tests listed below are skipped. Keeping
#   them here rather than changing upstream's test files means merging
#   upstream never conflicts over them.

set -euo pipefail

args=(--test-timeout=120000 --test-force-exit)
run=(npm run test:unit --)

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

warn_after=${UNIT_TESTS_WARN_AFTER:-300}
stop_after=${UNIT_TESTS_STOP_AFTER:-720}

# "[[dd-]hh:]mm:ss" as printed by ps, in seconds
seconds() {
  local days=0 rest=$1 h=0 m s
  if [[ $rest == *-* ]]; then
    days=${rest%%-*}
    rest=${rest#*-}
  fi
  IFS=: read -r -a parts <<<"$rest"
  if [ "${#parts[@]}" = 3 ]; then
    h=${parts[0]} m=${parts[1]} s=${parts[2]}
  else
    m=${parts[0]} s=${parts[1]}
  fi
  echo $((10#$days * 86400 + 10#$h * 3600 + 10#$m * 60 + 10#$s))
}

# The test runner runs each test file in a process of its own, whose command
# line ends with that file
watchdog() {
  local warned=' ' stopped=' '
  while sleep 30; do
    while read -r pid elapsed command; do
      files=$(grep -oE '[^ ]*/test/[^ ]*-test\.[cm]?[jt]sx?' <<<"$command" || true)
      # Only the processes of a single file, not the runner listing them all
      if [ -z "$files" ] || [[ $files == *$'\n'* ]]; then
        continue
      fi
      file=${files#"$PWD/"}
      secs=$(seconds "$elapsed")
      minutes=$((secs / 60))
      if [ "$secs" -ge "$stop_after" ]; then
        if [[ $stopped == *" $pid "* ]]; then
          kill -KILL "$pid" 2>/dev/null || true
        else
          echo "::error file=$file,title=Test file stopped::$file was still running after $minutes minutes, so it was stopped."
          kill "$pid" 2>/dev/null || true
          stopped+="$pid "
        fi
      elif [ "$secs" -ge "$warn_after" ] && [[ $warned != *" $pid "* ]]; then
        echo "::warning file=$file,title=Slow test file::$file has been running for $minutes minutes."
        warned+="$pid "
      fi
    done < <(ps -eo pid=,etime=,args=)
  done
}

watchdog &
watchdog_pid=$!
status=0
"${run[@]}" "${args[@]}" "$@" || status=$?
kill "$watchdog_pid" 2>/dev/null || true
exit "$status"
