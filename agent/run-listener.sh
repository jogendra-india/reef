#!/bin/bash
# Self-healing wrapper for `reef-agent.mjs listen`. Something in at least one
# sandboxed environment intermittently signals long-running background
# processes — no exception, no stderr trace, just gone (exit via signal, not
# a JS error). That can't be fixed from inside the script since whatever
# sends the signal is outside our control; instead it's made irrelevant:
# relaunch immediately on any exit, so an accidental kill costs seconds of
# gap instead of sitting dead until someone notices.
#
# STOPPING IT ON PURPOSE
#
# The point above is that a signal to the *node child* is assumed accidental
# and gets restarted — so `kill <listener-pid>` alone cannot also mean "stay
# dead" without defeating the crash recovery that is this script's whole
# reason to exist. A deliberate stop is therefore expressed against the
# *wrapper*, which nothing here ever restarts:
#
#   agent/stop-listener.sh <state-file>     # preferred: does it and verifies
#   kill "$(cat <state-file>.wrapper.pid)"  # equivalent, one step
#
# Either trips the trap below, which kills the child and exits the loop. The
# older two-step sentinel path still works and is still honoured after any
# child exit, for anything already scripted against it:
#
#   touch <state-file>.stop && kill "$(cat <state-file>.lock)"
#
# Usage: run-listener.sh <state-file>
set -u
cd "$(dirname "$0")/.."

STATE="${1:-}"
if [ -z "$STATE" ]; then
  echo "usage: run-listener.sh <state-file>" >&2
  exit 2
fi
STOP_FILE="${STATE}.stop"
WRAPPER_PID_FILE="${STATE}.wrapper.pid"
rm -f "$STOP_FILE"

# Published so a deliberate stop has one discoverable thing to signal, instead
# of having to find this process in `ps` and guess which pid is the supervisor.
echo "$$" > "$WRAPPER_PID_FILE"

child=""
log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) [wrapper] $1" >> agent/listen.log; }

# A signal aimed at the wrapper is deliberate by construction: nothing restarts
# the wrapper, so there is no accidental-kill case to defend against at this
# level, and honouring it is what makes `kill <wrapper-pid>` mean stay-dead.
shutdown() {
  trap - TERM INT
  log "stop signal received, shutting down without restart"
  if [ -n "$child" ]; then
    kill "$child" 2>/dev/null || true
    wait "$child" 2>/dev/null || true
  fi
  rm -f "$WRAPPER_PID_FILE" "$STOP_FILE"
  exit 0
}
trap shutdown TERM INT

log "wrapper started (pid $$) for $STATE"

while true; do
  node --use-system-ca agent/reef-agent.mjs --state "$STATE" --label "Claude-agent" listen >> agent/listen.log 2>&1 &
  child=$!
  # `wait` rather than a foreground child, so the trap can fire while the child
  # is still running. A foreground child would delay the signal until it exited
  # on its own, which for a healthy listener is never.
  wait "$child"
  code=$?
  child=""

  if [ -f "$STOP_FILE" ]; then
    log "stop file present, exiting (last code $code)"
    rm -f "$STOP_FILE" "$WRAPPER_PID_FILE"
    exit 0
  fi
  log "listen exited (code $code), restarting in 3s"
  sleep 3
done
