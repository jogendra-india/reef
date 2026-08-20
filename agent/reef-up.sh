#!/bin/bash
# Bring the Reef listener up for the current chat session, idempotently, and
# print the one Monitor command that follows.
#
# WHY THIS EXISTS
#
# Every fresh chat that says "go reef way" used to redo the same bootstrap by
# hand: find the checkout (whose path differs per machine), work out where node
# lives (nvm/mise/Homebrew/Program Files — and a non-interactive shell often
# cannot see it), read the lock and wrapper pid files, check both against `ps`,
# decide whether to launch, then remember the exact nohup incantation. That is
# several tool calls and a paragraph of reasoning to reach a yes/no that a
# script can answer, so it is a script now. It is also the only piece that
# needs to know per-machine facts, which is why nothing here is hardcoded to
# one checkout path.
#
# It is safe to run when a listener is already up: that is the common case, and
# the answer is "nothing to do, here is the Monitor command".
#
# Usage: reef-up.sh [state-file]
#   state-file defaults to $REEF_STATE, else the single non-test agent/*.json
#   state file in the checkout. Ambiguity is reported, never guessed.
#
# Exit codes: 0 listener is up (already, or just started) · 1 prerequisite
# missing (node, .env, state file) · 2 usage · 3 tried to start and it did not
# come up.
set -u
cd "$(dirname "$0")/.."
REPO="$(pwd)"

say() { printf '%s\n' "$*"; }
die() { printf '%s\n' "$*" >&2; exit "${2:-1}"; }

# ---------------------------------------------------------------- node on PATH
#
# A login shell resolves node from a version manager's shell hook, which a
# non-interactive tool call never runs — so `node` can be missing here while
# the same machine's terminal has it. Probe the usual install roots directly
# rather than relying on the hook. `sort -V` not `tail -1`: lexical order puts
# node 9 above node 22.
add_newest() { # add_newest <glob-of-version-dirs> <bin-subpath>
  local newest
  newest="$(ls -d $1 2>/dev/null | sort -V | tail -1)"
  [ -n "$newest" ] && [ -x "${newest}${2}/node" ] && PATH="${newest}${2}:$PATH"
}

if ! command -v node >/dev/null 2>&1; then
  add_newest "$HOME/.nvm/versions/node/*" "/bin"
  add_newest "$HOME/.local/share/mise/installs/node/*" "/bin"
  add_newest "$HOME/.local/share/fnm/node-versions/*" "/installation/bin"
  add_newest "$HOME/Library/Application Support/fnm/node-versions/*" "/installation/bin"
  for d in "$HOME/.volta/bin" /opt/homebrew/bin /usr/local/bin \
           "/c/Program Files/nodejs" "/c/Program Files (x86)/nodejs" \
           "${LOCALAPPDATA:-/nonexistent}/nvs/default" "${APPDATA:-/nonexistent}/nvm"; do
    if [ -x "$d/node" ] || [ -x "$d/node.exe" ]; then PATH="$d:$PATH"; fi
  done
  export PATH
fi

command -v node >/dev/null 2>&1 || die "reef-up: no node on PATH. Install it, or add its bin dir to PATH.
  nvm:   export PATH=\"\$HOME/.nvm/versions/node/\$(ls ~/.nvm/versions/node | sort -V | tail -1)/bin:\$PATH\""

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
NODE_MINOR="$(node -p 'process.versions.node.split(".")[1]' 2>/dev/null || echo 0)"
# run-listener.sh passes --use-system-ca unconditionally (the Windows corporate
# TLS fix). Node rejects an unknown engine flag outright, so on an older node
# the child dies instantly and the wrapper crash-loops every 3s — a failure
# that reads as "Reef is broken" rather than "node is too old". Say so here.
if [ "$NODE_MAJOR" -lt 22 ] || { [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -lt 9 ]; }; then
  die "reef-up: node $(node -v) is too old — run-listener.sh passes --use-system-ca, which needs node >= 22.9.
  Upgrade node (or drop that flag in agent/run-listener.sh if this machine has no TLS interception)."
fi

# ------------------------------------------------------------------ state file
STATE="${1:-${REEF_STATE:-}}"
if [ -z "$STATE" ]; then
  # Candidates are the agent's own state files: agent/*.json, minus the test
  # fixtures. The sidecars (.lock/.owner/.wrapper.pid/.stop) do not end in
  # .json so they are excluded for free.
  found=""
  count=0
  for f in agent/*.json; do
    [ -f "$f" ] || continue
    case "$(basename "$f")" in test-*) continue ;; esac
    grep -q '"session"' "$f" 2>/dev/null || continue
    found="$f"
    count=$((count + 1))
  done
  [ "$count" -eq 1 ] || die "reef-up: expected exactly one state file in agent/, found ${count}.
  Pass one explicitly: reef-up.sh agent/<file>.json (or set REEF_STATE)."
  STATE="$found"
fi
[ -f "$STATE" ] || die "reef-up: no such state file: $STATE"

# The PIN is the credential and must not sit in argv or shell history, so the
# agent reads it from agent/.env. Without that file the listener starts, fails
# to unlock, and crash-loops — check up front instead.
[ -f agent/.env ] && grep -q '^REEF_PIN=' agent/.env \
  || die "reef-up: agent/.env is missing a REEF_PIN= line (never pass --pin; it leaks via ps/history)."

ROOM="$(node -e '
  const fs = require("fs");
  try { process.stdout.write(String(JSON.parse(fs.readFileSync(process.argv[1], "utf8")).session?.roomId || "")); }
  catch { process.stdout.write(""); }
' "$STATE" 2>/dev/null || true)"

LOCK_FILE="${STATE}.lock"
WRAPPER_PID_FILE="${STATE}.wrapper.pid"
OWNER_FILE="${STATE}.owner"

# `kill -0` is the portable existence check and works for native processes under
# Git Bash too (it maps to OpenProcess, unlike -STOP which MSYS silently drops)
# -- but only when given the MSYS-translated pid. A pid written by a *native*
# win32 process (node's own `process.pid`, as the listener writes to its lock
# file) is the real Windows PID instead, which `kill -0` rejects outright
# ("No such process") even though the process is very much alive. `ps -W` is
# the fallback for that case -- but its own columns mix both pid flavors (col
# 1 is the MSYS pid, col 4 is the WINPID: for a bash process, like the
# wrapper, those differ; for a native process, like the listener, col 4 is
# the one that matches what's in the pid file). Check both columns rather
# than assume which one a given pid file holds.
pid_alive() {
  local pid="$1"
  [ -n "$pid" ] || return 1
  kill -0 "$pid" 2>/dev/null && return 0
  ps -W 2>/dev/null | awk -v p="$pid" '($1 == p) || ($4 == p) { found = 1 } END { exit !found }' && return 0
  return 1
}
# -f guard, not just `2>/dev/null` on tr: a missing file makes the *shell*
# complain about the input redirection, which redirecting tr's stderr does not
# suppress — and an absent pid file is the normal cold-start case, not an error.
read_pid() { [ -f "$1" ] && tr -d '[:space:]' < "$1" 2>/dev/null || true; }

WRAPPER_PID="$(read_pid "$WRAPPER_PID_FILE")"
LISTENER_PID="$(read_pid "$LOCK_FILE")"

started=0
if pid_alive "$WRAPPER_PID" && pid_alive "$LISTENER_PID"; then
  say "listener already up  (wrapper ${WRAPPER_PID}, listener ${LISTENER_PID})"
else
  # A half-up state is normal, not an error: the wrapper restarts its child
  # every 3s, so catching it mid-restart shows a live wrapper and a stale lock.
  # Launching again is safe either way — run-listener.sh no-ops when a wrapper
  # is already supervising this state file.
  if pid_alive "$WRAPPER_PID"; then
    say "wrapper ${WRAPPER_PID} alive, listener restarting — leaving it alone"
  else
    say "no live listener — starting one"
    # nohup + a closed stdin, detached from this shell: the harness that
    # supervises tool calls reaps its own background children, and that reaping
    # is exactly what the wrapper exists to survive. It cannot survive being
    # reaped itself.
    nohup bash agent/run-listener.sh "$STATE" >> agent/listener-wrapper.log 2>&1 < /dev/null &
    disown 2>/dev/null || true
    started=1

    # Wait for evidence, not a fixed sleep. `listening on room …` is the
    # listener's own first line once the socket is open.
    ok=0
    for _ in $(seq 1 40); do
      sleep 1
      WRAPPER_PID="$(read_pid "$WRAPPER_PID_FILE")"
      LISTENER_PID="$(read_pid "$LOCK_FILE")"
      if pid_alive "$WRAPPER_PID" && pid_alive "$LISTENER_PID"; then ok=1; break; fi
    done
    [ "$ok" -eq 1 ] || {
      say ""
      say "--- last 15 lines of agent/listen.log ---"
      tail -15 agent/listen.log 2>/dev/null
      die "reef-up: listener did not come up within 40s (see above, and agent/listener-wrapper.log)." 3
    }
    say "started  (wrapper ${WRAPPER_PID}, listener ${LISTENER_PID})"
  fi
fi

# ---------------------------------------------------------------------- report
CURRENT_OWNER="$(read_pid "$OWNER_FILE")"
say ""
say "repo:     ${REPO}"
say "state:    ${STATE}"
say "room:     ${ROOM:-unknown}"
say "node:     $(node -v)"
if [ -n "$CURRENT_OWNER" ] && [ "$CURRENT_OWNER" != "${CLAUDE_CODE_SESSION_ID:-}" ]; then
  # Not a problem to fix here: starting the Monitor below claims ownership, and
  # the previous owner's inbox.sh notices and exits by itself.
  say "owner:    ${CURRENT_OWNER} (another session — the Monitor below takes over)"
else
  say "owner:    ${CURRENT_OWNER:-none yet}"
fi
[ "$started" -eq 1 ] && say "note:     freshly started, so anything said while it was down arrives via catch-up"

# Printed last and in one piece so the caller can lift it verbatim into Monitor
# instead of reassembling the path.
say ""
say "MONITOR_CMD: cd ${REPO} && bash agent/inbox.sh ${STATE}"
say "STOP_CMD:    cd ${REPO} && bash agent/stop-listener.sh ${STATE}"
