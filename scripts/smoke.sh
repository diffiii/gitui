#!/usr/bin/env bash
# Starts the bundled CLI with node in its default (hosted) mode and with --local, and checks
# what each serves. Usage: scripts/smoke.sh [path/to/gitui.js] (default apps/cli/dist/gitui.js).
set -euo pipefail

bin=${1:-apps/cli/dist/gitui.js}
tmp=$(mktemp -d)
export XDG_CONFIG_HOME=$tmp
pid=
trap '[ -n "$pid" ] && kill "$pid" 2>/dev/null; rm -rf "$tmp"' EXIT

fail() {
  echo "smoke: $1" >&2
  cat "$tmp/out.log" >&2
  exit 1
}

# Starts gitui with the given flags and sets $base once it listens. The port comes from the
# pairing link, since gitui moves to the next free port if 4870 is taken.
start() {
  node "$bin" --no-open -p 4870 "$@" >"$tmp/out.log" 2>&1 &
  pid=$!
  for _ in $(seq 100); do
    port=$(sed -n 's/^pairing link: .*#port=\([0-9]*\)&.*/\1/p' "$tmp/out.log")
    if [ -n "$port" ]; then
      base=http://127.0.0.1:$port
      return
    fi
    kill -0 "$pid" 2>/dev/null || fail "gitui $* exited"
    sleep 0.1
  done
  fail "gitui $* did not start"
}

stop() {
  kill "$pid"
  wait "$pid" 2>/dev/null || true
  pid=
}

status() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

start
curl -fsS -H 'x-gitui: 1' "$base/api/config" | grep -q '"recent"' || fail "/api/config failed"
[ "$(status "$base/")" = 404 ] || fail "hosted mode served /"
grep -q 'running at' "$tmp/out.log" && fail "hosted mode printed a local URL"
stop

start --local
curl -fsS "$base/" | grep -q '<div id="root">' || fail "--local did not serve the UI"
curl -fsS -H 'x-gitui: 1' "$base/api/config" | grep -q '"recent"' || fail "/api/config failed"
[ "$(status -H 'x-gitui: 1' "$base/api/nope")" = 404 ] || fail "unknown API route is not a 404"
[ "$(status "$base/assets/missing.js")" = 404 ] || fail "missing asset is not a 404"
grep -q "running at $base/" "$tmp/out.log" || fail "--local did not print its URL"
stop

echo "smoke: ok"
