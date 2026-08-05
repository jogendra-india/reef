#!/bin/bash
# Self-healing wrapper for `reef-agent.mjs listen`. Something in at least one
# sandboxed environment intermittently signals long-running background
# processes — no exception, no stderr trace, just gone (exit via signal, not
# a JS error). That can't be fixed from inside the script since whatever
# sends the signal is outside our control; instead it's made irrelevant:
# relaunch immediately on any exit, so an accidental kill costs seconds of
# gap instead of sitting dead until someone notices.
#
# A deliberate stop has to be distinguishable from that accidental kill, or
# this would just resurrect a listener someone meant to shut down. Stopping
# on purpose touches a sentinel file next to the state file before killing
# the node process; the wrapper checks for it after every exit and, if
# present, exits the loop instead of restarting.
#
# Usage: run-listener.sh <state-file>
# Stop:  touch <state-file>.stop && kill "$(cat <state-file>.lock)"
set -u
cd "$(dirname "$0")/.."

STATE="${1:-}"
if [ -z "$STATE" ]; then
  echo "usage: run-listener.sh <state-file>" >&2
  exit 2
fi
STOP_FILE="${STATE}.stop"
rm -f "$STOP_FILE"

while true; do
  node --use-system-ca agent/reef-agent.mjs --state "$STATE" --label "Claude-agent" listen >> agent/listen.log 2>&1
  code=$?
  if [ -f "$STOP_FILE" ]; then
    echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) [wrapper] stop file present, exiting (last code $code)" >> agent/listen.log
    rm -f "$STOP_FILE"
    exit 0
  fi
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) [wrapper] listen exited (code $code), restarting in 3s" >> agent/listen.log
  sleep 3
done
