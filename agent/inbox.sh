#!/bin/bash
# Take over this Reef conversation for the current chat session, and stream
# only the messages addressed to that session.
#
# WHY THIS EXISTS
#
# The old arrangement had every session run `tail -f agent/listen.log` and grep
# for REEF_MSG. That is a broadcast: open a second chat, say "go reef way", and
# now two sessions are notified about every message in a conversation only one
# of them is holding. Both wake an LLM turn, both reach for `claim-message.sh`,
# and the winner is whichever tool call happened to land first — which is never
# the answer you want, since the session the operator is actually looking at is
# the one that should reply.
#
# Ownership replaces that race. This script writes its session id to
# <state-file>.owner, and the listener appends each incoming message to
# agent/inbox/<owner>.log — so exactly one session is ever notified, decided by
# who most recently ran this, not by who reacted fastest. A previous owner's
# copy of this script notices it has been superseded, says so once, and exits,
# which is how the older chat goes quiet without anyone having to remember to
# stop it.
#
# Usage: inbox.sh <state-file> [session-id]
#   session-id defaults to $CLAUDE_CODE_SESSION_ID (set in every Claude Code
#   shell), so the normal invocation is just the state file.
#
# Run it as the Monitor command, not by hand: its stdout is one line per
# incoming message plus the handover/crash notices worth interrupting for.
set -u
cd "$(dirname "$0")/.."

STATE="${1:-}"
SESSION="${2:-${CLAUDE_CODE_SESSION_ID:-}}"
if [ -z "$STATE" ] || [ -z "$SESSION" ]; then
  echo "usage: inbox.sh <state-file> [session-id]   (defaults to \$CLAUDE_CODE_SESSION_ID)" >&2
  exit 2
fi
# The id becomes a filename on both sides of the handoff, so reject anything
# that is not one here rather than discovering it as a stray path later.
case "$SESSION" in
  *[!A-Za-z0-9._-]*) echo "inbox.sh: session id must match [A-Za-z0-9._-]" >&2; exit 2 ;;
esac

OWNER_FILE="${STATE}.owner"
LISTEN_LOG="agent/listen.log"
INBOX_DIR="agent/inbox"
INBOX="${INBOX_DIR}/${SESSION}.log"

mkdir -p "$INBOX_DIR"
touch "$INBOX"

# Written via rename so the file is never briefly half a session id: a message
# delivered mid-handover lands in one inbox or the other, never in neither.
printf '%s\n' "$SESSION" > "${OWNER_FILE}.tmp"
mv -f "${OWNER_FILE}.tmp" "$OWNER_FILE"
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) [inbox] owner -> ${SESSION}" >> "$LISTEN_LOG"

# Anything that arrived while no session owned the room is not lost, but it is
# not replayed as notifications either — an unread pile becoming a burst of
# interrupts is its own problem. Say it is there; let the session decide.
# Guarded with -f rather than redirecting wc's stderr: a missing file makes the
# *shell* complain about the input redirection, which 2>/dev/null on wc does not
# suppress — that noise ends up on the monitor's stdout as a fake event.
if [ -f "${INBOX_DIR}/unowned.log" ]; then
  waiting="$(wc -l < "${INBOX_DIR}/unowned.log" | tr -d ' ')"
  if [ "${waiting:-0}" -gt 0 ]; then
    echo "[inbox] ${waiting} message(s) arrived while unowned: ${INBOX_DIR}/unowned.log"
  fi
fi

echo "[inbox] listening as ${SESSION}"

# No `tail` and no background child, deliberately. The first version ran
# `tail -F` in the background feeding a fifo, and under Monitor the tail was
# reaped within seconds — the same reaping that `run-listener.sh` exists to
# undo — leaving this script reporting a dead stream. Whatever supervises a
# monitor tolerates one foreground process and not much else, so this reads the
# files itself.
#
# Reading them directly is possible because EOF on a *regular* file is not
# sticky: the fd keeps its offset, so once the writer appends, the next read
# returns the new bytes. That gives a plain foreground loop with a 1s idle
# poll — cheap (two local reads), and idle costs nothing upstream since a
# monitor only wakes an LLM turn when a line is actually printed.
exec 3< "$INBOX"
exec 4< "$LISTEN_LOG"

# Existing content is history, not events. Skipping it here is the equivalent
# of `tail -n 0`: a monitor that replayed the file on startup would announce
# every message the room has ever had as new.
skip_to_end() { while IFS= read -r -u "$1" _; do :; done; }
skip_to_end 3
skip_to_end 4

while true; do
  # First, so a superseded session stops promptly even in a silent room, and
  # before emitting anything it is no longer entitled to.
  current="$(tr -d '[:space:]' < "$OWNER_FILE" 2>/dev/null)"
  if [ "$current" != "$SESSION" ]; then
    echo "[inbox] ownership moved to ${current:-none} — this session stops listening"
    exit 0
  fi

  # This session's inbox: message text, written by the listener only while this
  # session owns the room.
  while IFS= read -r -u 3 line; do
    case "$line" in REEF_MSG\ *) printf '%s\n' "$line" ;; esac
  done

  # listen.log is read for one thing only: a crash-looping listener and a quiet
  # room are otherwise indistinguishable. Not `reef: ` — transient backend
  # errors arrive in bursts, and a burst gets the whole monitor auto-suppressed,
  # which is how crash visibility gets lost in the first place.
  while IFS= read -r -u 4 line; do
    case "$line" in *"[wrapper] listen exited"*) printf '%s\n' "$line" ;; esac
  done

  sleep 1
done
