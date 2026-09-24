#!/usr/bin/env bash
# Start the API (with its workers) and, when asked, the SAP simulator.
#
# The simulator is opt-in via RUN_SAP_SIMULATOR because it fabricates Sales Order
# numbers — correct for a demo, catastrophic against a real SAP landscape. It also
# refuses to start under NODE_ENV=production unless SAP_SIM_ALLOW_IN_PRODUCTION=true.
set -uo pipefail

log() { printf '[start] %s\n' "$*"; }

# The app creates these itself, but doing it here means a bad mount fails loudly
# now rather than halfway through the first upload.
mkdir -p "${STORAGE_ROOT:-/app/data/storage}" "${INTEGRATION_ROOT:-/app/data/integration}"

if [ "${RUN_MIGRATIONS:-false}" = "true" ]; then
  log "running prisma migrate deploy"
  if ! npx prisma migrate deploy --schema backend/prisma/schema.prisma; then
    log "MIGRATION FAILED — refusing to start with a schema that may not match the code"
    exit 1
  fi
fi

# The seed is upsert-based and idempotent: users keep their ids, vendor profiles
# keep their versions, and re-running it only refreshes names, roles and prompts.
# Running it on boot means new vendor profiles reach a hosted database without
# anyone needing the connection string on a laptop.
if [ "${RUN_SEED:-false}" = "true" ]; then
  log "running database seed (idempotent upserts)"
  if ! npx tsx backend/prisma/seed.ts; then
    log "SEED FAILED — continuing; the app works with whatever is already seeded"
  fi
fi

node backend/dist/server.js &
API_PID=$!
log "api started (pid $API_PID)"

SIM_PID=""
if [ "${RUN_SAP_SIMULATOR:-false}" = "true" ]; then
  node backend/dist/simulator/sapSimulator.js &
  SIM_PID=$!
  log "sap simulator started (pid $SIM_PID)"
else
  log "sap simulator not started (set RUN_SAP_SIMULATOR=true for a demo environment)"
fi

shutdown() {
  log "shutting down"
  # shellcheck disable=SC2086
  kill -TERM "$API_PID" $SIM_PID 2>/dev/null || true
  wait "$API_PID" 2>/dev/null || true
  exit 0
}
trap shutdown TERM INT

# The API is the process that matters; if it dies, the container should die with it
# so the platform restarts us rather than serving a UI with no backend.
wait "$API_PID"
STATUS=$?
log "api exited with status $STATUS"
[ -n "$SIM_PID" ] && kill -TERM "$SIM_PID" 2>/dev/null || true
exit "$STATUS"
