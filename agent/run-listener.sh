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

# How long listen.log may go untouched before the watchdog below decides the
# child is frozen rather than just connected to a quiet room. Must clear the
# worst *legitimate* gap: two missed pings (~40s) + giveUp + jittered backoff
# (up to ~40s) + a fresh connect (up to the 30s connect deadline) + one
# heartbeat tick (20s) before the first post-reconnect line lands -- under
# 150s in practice, so 240s leaves real margin without leaving a freeze
# undetected for anywhere near as long as it can currently go unnoticed.
STALE_SECS=240

# One wrapper per state file. A second chat session following the setup steps
# runs this again, and without this check the newcomer overwrote
# WRAPPER_PID_FILE with its own pid — pointing stop-listener.sh at the
# redundant wrapper and leaving the real one unreachable by file — then
# crash-looped every 3s because the live listener still holds the lock. Exit 0,
# not an error: the desired end state (a listener is running for this state
# file) is already true, so this is a no-op, and a fresh chat can safely run
# the launch command without checking first.
if [ -f "$WRAPPER_PID_FILE" ]; then
  existing="$(tr -d '[:space:]' < "$WRAPPER_PID_FILE" 2>/dev/null)"
  if [ -n "$existing" ] && kill -0 "$existing" 2>/dev/null; then
    echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) [wrapper] already running for $STATE (pid $existing), nothing to do" >> agent/listen.log
    echo "listener already running for $STATE (wrapper pid $existing)"
    exit 0
  fi
fi

rm -f "$STOP_FILE"

# Published so a deliberate stop has one discoverable thing to signal, instead
# of having to find this process in `ps` and guess which pid is the supervisor.
echo "$$" > "$WRAPPER_PID_FILE"

child=""
watchdog=""
log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) [wrapper] $1" >> agent/listen.log; }

export PATH="$HOME/.nvm/versions/node/$(ls ~/.nvm/versions/node 2>/dev/null | tail -1)/bin:$PATH"

# A signal aimed at the wrapper is deliberate by construction: nothing restarts
# the wrapper, so there is no accidental-kill case to defend against at this
# level, and honouring it is what makes `kill <wrapper-pid>` mean stay-dead.
shutdown() {
  trap - TERM INT
  log "stop signal received, shutting down without restart"
  if [ -n "$watchdog" ]; then
    kill "$watchdog" 2>/dev/null || true
  fi
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

  # External staleness watchdog. reef-agent.mjs prints a heartbeat line to
  # listen.log every 20s while a socket is open specifically so this can
  # exist: the in-process ping/pong check can only fire if the event loop is
  # still running to execute it, so it cannot catch the process itself
  # stalling -- observed live as a child that never exited, and so was never
  # restarted, silent (no heartbeat, no real incoming messages logged either)
  # for the better part of an hour. This polls from outside instead and kills
  # the child if it stops writing; the crash-loop restart just below already
  # knows how to recover from that, same as any other exit.
  (
    trap - TERM INT
    while kill -0 "$child" 2>/dev/null; do
      sleep 30
      kill -0 "$child" 2>/dev/null || break
      last="$(stat -c %Y agent/listen.log 2>/dev/null || echo 0)"
      now="$(date +%s)"
      if [ $((now - last)) -gt "$STALE_SECS" ]; then
        log "listen.log stale for ${STALE_SECS}s+, child pid $child looks frozen -- killing it"
        kill "$child" 2>/dev/null
        break
      fi
    done
  ) &
  watchdog=$!

  # `wait` rather than a foreground child, so the trap can fire while the child
  # is still running. A foreground child would delay the signal until it exited
  # on its own, which for a healthy listener is never.
  wait "$child"
  code=$?
  child=""
  kill "$watchdog" 2>/dev/null
  watchdog=""

  if [ -f "$STOP_FILE" ]; then
    log "stop file present, exiting (last code $code)"
    rm -f "$STOP_FILE" "$WRAPPER_PID_FILE"
    exit 0
  fi
  # 12 = LOCK_CONFLICT_EXIT in reef-agent.mjs: another listener holds the lock
  # and is alive. Restarting cannot resolve that, it just reprints the refusal
  # every 3s — the whole point of this loop is undoing *accidental* deaths, and
  # this is a deliberate refusal. Leave the pid file alone: it belongs to
  # whichever wrapper is actually supervising the live listener.
  if [ "$code" -eq 12 ]; then
    log "another listener owns the lock, exiting without restart"
    # Reached when the pid file was stale/absent at startup (so the guard above
    # let this wrapper through) but a listener was in fact alive. This wrapper
    # has since published its own pid; leaving it behind on the way out would
    # point stop-listener.sh at a dead process. Absent is recoverable — the
    # lock file still names the live listener — a wrong pid is not.
    if [ "$(tr -d '[:space:]' < "$WRAPPER_PID_FILE" 2>/dev/null)" = "$$" ]; then
      rm -f "$WRAPPER_PID_FILE"
    fi
    exit 0
  fi
  log "listen exited (code $code), restarting in 3s"
  sleep 3
done
