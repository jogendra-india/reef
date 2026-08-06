#!/bin/bash
# Cross-session claim for "who gets to reply" to one incoming Reef message.
#
# Why this exists: `listen`'s PID lock (<state>.lock) stops two *listener*
# processes running for the same state file, but nothing stops two separate
# Claude Code sessions from each tailing the same agent/listen.log, each
# noticing the same REEF_MSG line, and each independently calling `send` —
# same device, two (or more) replies to one message. The lock protects the
# writer; this protects the reaction to what it writes.
#
# Mechanism: `mkdir` is atomic even across processes on the same filesystem —
# exactly one caller for a given message id can win it. Whoever's session is
# about to compose a reply to a REEF_MSG runs this first; only the winner
# proceeds to `send`, everyone else exits 1 and stays silent.
#
# Usage: claim-message.sh <state-file> <message-id>
# Exit 0 + prints CLAIMED   -> you own this message, go ahead and reply.
# Exit 1 + prints ALREADY_CLAIMED -> another session already has it, skip.
set -u
cd "$(dirname "$0")/.."

STATE="${1:-}"
MSG_ID="${2:-}"
if [ -z "$STATE" ] || [ -z "$MSG_ID" ]; then
  echo "usage: claim-message.sh <state-file> <message-id>" >&2
  exit 2
fi

CLAIMS_DIR="${STATE}.claims"
mkdir -p "$CLAIMS_DIR"

if mkdir "${CLAIMS_DIR}/${MSG_ID}" 2>/dev/null; then
  echo "CLAIMED"
  exit 0
else
  echo "ALREADY_CLAIMED"
  exit 1
fi
