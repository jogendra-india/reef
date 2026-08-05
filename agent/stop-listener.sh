#!/bin/bash
# Stop a `run-listener.sh` supervisor and its listener, and make it stay stopped.
#
# Why this exists: the wrapper restarts the node child on any exit, on purpose —
# a sandboxed harness intermittently signals long-running processes, and losing
# the listener for hours because of that was the original problem. The cost is
# that `kill <listener-pid>` is indistinguishable from that accidental kill, so
# it comes back in 3s. Stopping for real means signalling the *wrapper*, plus a
# sentinel so a child that happens to exit in the same window is not restarted
# by a wrapper that has not processed the signal yet.
#
# Doing that by hand is three steps in the right order, and getting it wrong
# looks like "the thing I killed keeps coming back". Hence a script.
#
# Usage: stop-listener.sh <state-file>
set -u
cd "$(dirname "$0")/.."

STATE="${1:-}"
if [ -z "$STATE" ]; then
  echo "usage: stop-listener.sh <state-file>" >&2
  exit 2
fi

STOP_FILE="${STATE}.stop"
LOCK_FILE="${STATE}.lock"
WRAPPER_PID_FILE="${STATE}.wrapper.pid"

# Sentinel first: it is the one thing that stops a *restart* racing us if the
# child exits between the kills below and the wrapper acting on its signal.
touch "$STOP_FILE"

wrapper_pid="$(cat "$WRAPPER_PID_FILE" 2>/dev/null || true)"
listener_pid="$(cat "$LOCK_FILE" 2>/dev/null || true)"

# Wrapper before child: kill the child first and a wrapper that has not yet seen
# its own signal would relaunch it (the sentinel covers that, but this ordering
# means we do not rely on the sentinel for the common case).
if [ -n "$wrapper_pid" ] && kill -0 "$wrapper_pid" 2>/dev/null; then
  echo "stopping wrapper pid $wrapper_pid"
  kill "$wrapper_pid" 2>/dev/null || true
else
  echo "no live wrapper found (${WRAPPER_PID_FILE})"
fi

if [ -n "$listener_pid" ] && kill -0 "$listener_pid" 2>/dev/null; then
  echo "stopping listener pid $listener_pid"
  kill "$listener_pid" 2>/dev/null || true
fi

# The wrapper sleeps 3s between restarts, so anything that was going to come
# back has done so well inside this window.
sleep 6

fail=0
if [ -n "$wrapper_pid" ] && kill -0 "$wrapper_pid" 2>/dev/null; then
  echo "STILL ALIVE: wrapper pid $wrapper_pid" >&2
  fail=1
fi
still_listening="$(pgrep -f "reef-agent.mjs --state ${STATE}" || true)"
if [ -n "$still_listening" ]; then
  echo "STILL ALIVE: listener pid(s) $still_listening" >&2
  fail=1
fi

# Left behind only if a process died without running its own cleanup; harmless
# to remove here since we have just verified nothing is holding them.
[ "$fail" -eq 0 ] && rm -f "$WRAPPER_PID_FILE" "$LOCK_FILE" "$STOP_FILE"

if [ "$fail" -eq 0 ]; then
  echo "stopped, and will not restart"
else
  echo "stop INCOMPLETE — something is still running, see above" >&2
  exit 1
fi
