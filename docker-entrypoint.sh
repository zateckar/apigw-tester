#!/bin/sh
# Repair /app/data ownership, then drop privileges and run the server as `bun`.
#
# A named volume inherits the image's ownership only when Docker seeds it from
# empty. A volume that predates the unprivileged `bun` user in this Dockerfile — or any bind
# mount supplied by the host — arrives owned by whoever created it, Docker will
# not re-seed it, and the unprivileged server then dies opening the database:
#
#   Error: unable to open database file   (ERR_SQLITE_ERROR, errcode 14)
#
# SQLite needs write permission on the directory, not just on metrics.db, because
# WAL mode creates metrics.db-wal and metrics.db-shm next to it. Under
# `restart: unless-stopped` that failure becomes an endless crash loop, so fix it
# here, in the one moment we still have the privileges to do it.
set -e

if [ "$(id -u)" = "0" ]; then
  mkdir -p /app/data
  chown -R bun:bun /app/data 2>/dev/null ||
    echo "[apigw-tester] warning: could not chown /app/data — the server may be unable to write metrics.db" >&2
  # su-exec drops root rather than gaining anything, so this stays compatible
  # with no-new-privileges.
  exec su-exec bun "$@"
fi

# Already unprivileged (compose `user:` override, rootless Docker): nothing to
# repair, and no way to repair it. Hand straight over to the server, which
# reports an actionable error if the path is still unwritable.
exec "$@"
