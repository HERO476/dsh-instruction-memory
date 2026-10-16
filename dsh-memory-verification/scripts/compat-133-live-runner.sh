#!/usr/bin/env bash
# L3 live-verification runner for dsh-instruction-memory
# (created 2026-10-16 for plugin 1.3.3 vs DSH 0.2.1-alpha.3 / 0.2.1-alpha.4;
#  reusable for any isolated tree / label / port).
#
#   bash scripts/compat-133-live-runner.sh <tree> <label> <port>
#   e.g. bash scripts/compat-133-live-runner.sh alpha3 live-alpha3 8093
#
# Boots the isolated host tree in tmp/hosts/<tree> against the isolated
# DSH_HOME in tmp/homes/<label> (see COMPAT-1016-2026-10-10.md §2.5 for the
# isolated-install recipe and the plugin-add step), extracts the access token
# from the boot banner, runs the 21-assertion HTTP probe
# (scripts/compat-1016-live-check.mjs), then stops the host and verifies the
# port is released.
#
# Evidence:
#   out/compat-1016-live-<label>.json   (live-check output; rename as needed)
#   tmp/l3-<label>-boot.log             (host boot log)
set -u
if [ -z "${1:-}" ] || [ -z "${2:-}" ] || [ -z "${3:-}" ]; then
  echo "usage: bash scripts/compat-133-live-runner.sh <tree> <label> <port>"
  exit 2
fi
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
V="$(cd "$HERE/.." && pwd)"          # dsh-memory-verification
REPO="$(cd "$V/.." && pwd)"          # repository root
TREE="$1"; LABEL="$2"; PORT="$3"
HOMEWIN="$(cygpath -m "$V")/tmp/homes/$LABEL"
BIN="$V/tmp/hosts/$TREE/node_modules/@deepseek-ai/dsh/lib/bin.js"
BOOTLOG="$V/tmp/l3-$LABEL-boot.log"
rm -f "$BOOTLOG"
cd "$REPO"

DSH_HOME="$HOMEWIN" node "$BIN" web --no-open --host 127.0.0.1 --port "$PORT" > "$BOOTLOG" 2>&1 &
echo "[runner] host starting (tree=$TREE home=$HOMEWIN port=$PORT) ..."
for _ in $(seq 1 90); do
  grep -q 'token=' "$BOOTLOG" 2>/dev/null && break
  sleep 1
done
TOKEN=$(grep -o 'token=[^&[:space:]]*' "$BOOTLOG" | head -1 | cut -d= -f2)
echo "[runner] token = ${TOKEN:-<none>}"
if [ -z "${TOKEN:-}" ]; then echo "[runner] NO TOKEN — boot log follows:"; cat "$BOOTLOG"; exit 3; fi

node "$V/scripts/compat-1016-live-check.mjs" "http://127.0.0.1:$PORT" "$HOMEWIN" "$LABEL" "$TOKEN"
EC=$?
echo "[runner] live-check exit=$EC"

WINPID=$(netstat -ano 2>/dev/null | grep "127.0.0.1:$PORT" | grep -i LISTENING | awk '{print $NF}' | head -1)
echo "[runner] stopping host (winpid=$WINPID)"
if [ -n "${WINPID:-}" ]; then taskkill //F //PID "$WINPID" >/dev/null 2>&1; fi
sleep 2
if netstat -ano 2>/dev/null | grep -q "127.0.0.1:$PORT.*LISTENING"; then
  echo "[runner] WARN: port $PORT still listening"
else
  echo "[runner] port $PORT released"
fi
exit $EC
