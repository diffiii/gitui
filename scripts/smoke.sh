#!/usr/bin/env bash
# Starts the bundled CLI with node in its default (hosted) mode, with --local and with --lan, and
# checks what each serves. Usage: scripts/smoke.sh [path/to/gitui.js] (default apps/cli/dist/gitui.js).
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
# pairing link (hosted `#port=<n>&…`, or LAN `http://<address>:<n>/pair?…`), since gitui moves to
# the next free port if 4870 is taken.
start() {
  node "$bin" --no-open -p 4870 "$@" >"$tmp/out.log" 2>&1 &
  pid=$!
  for _ in $(seq 100); do
    port=$(sed -n -e 's/^pairing link: .*#port=\([0-9]*\)&.*/\1/p' \
      -e 's|^pairing link: http://[^/]*:\([0-9]*\)/pair?.*|\1|p' "$tmp/out.log")
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
curl -fsSI "$base/" | grep -qi "^content-security-policy: script-src 'self'" ||
  fail "--local did not send the CSP"
curl -s "$base/_headers" | grep -q 'Content-Security-Policy' && fail "--local served _headers"
grep -q "running at $base/" "$tmp/out.log" || fail "--local did not print its URL"
stop

start --lan 127.0.0.1
jar=$tmp/cookies
curl -fsS "$base/" | grep -q '<meta name="gitui-local-ui"' || fail "--lan did not serve the marked UI"
[ "$(status -H 'x-gitui: 1' "$base/api/config")" = 401 ] || fail "--lan API is open without a session"
link=$(sed -n 's/^pairing link: //p' "$tmp/out.log")
[ "$(status -c "$jar" "$link")" = 302 ] || fail "--lan pairing link did not redirect"
curl -fsS -b "$jar" -H 'x-gitui: 1' "$base/api/config" | grep -q '"recent"' ||
  fail "--lan API failed with the session"
grep -q 'plain HTTP' "$tmp/out.log" || fail "--lan did not print the plain HTTP warning"
stop

echo "smoke: ok"
