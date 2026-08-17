#!/usr/bin/env bash
# Apply the stellar migrations, in filename order, exactly once each.
#
#   api/db/pg/apply.sh              # apply what is pending
#   api/db/pg/apply.sh --dry-run    # list what would run
#
# Each file runs inside a single transaction, so a failure leaves nothing
# half-applied. The ledger row is written in the SAME transaction as the DDL —
# a file cannot be recorded as applied unless it actually was.
#
# Deliberately not docker-entrypoint-initdb.d: that only runs on an empty data
# directory, which means it silently does nothing the second time and gives no
# way to add a migration later.
set -euo pipefail

DRY_RUN=false
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=true

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTAINER="${STELLAR_CONTAINER:-stellar-postgres-1}"
PSQL=(docker exec -i "$CONTAINER" psql -v ON_ERROR_STOP=1 -U stellar -d stellar)

if ! docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  echo "Container '$CONTAINER' is not running." >&2
  echo "Start it with: docker compose -f docker-compose.stellar.yml up -d" >&2
  exit 1
fi

# The ledger has to exist before it can be consulted; 001 creates it, so the
# first run bootstraps with a direct check instead.
applied() {
  "${PSQL[@]}" -tAc \
    "SELECT 1 FROM stellar.schema_migration WHERE filename = '$1'" 2>/dev/null | grep -q 1
}

shopt -s nullglob
for path in "$DIR"/[0-9]*.sql; do
  file="$(basename "$path")"

  if applied "$file"; then
    echo "  skip  $file"
    continue
  fi

  if $DRY_RUN; then
    echo "  WOULD APPLY  $file"
    continue
  fi

  echo "  apply $file"
  # BEGIN/COMMIT wrap both the DDL and its ledger row. Postgres has
  # transactional DDL, which is the whole reason this is safe.
  {
    echo "BEGIN;"
    cat "$path"
    printf "\nINSERT INTO stellar.schema_migration (filename, checksum) VALUES ('%s', '%s');\n" \
      "$file" "$(sha256sum "$path" | cut -c1-16)"
    echo "COMMIT;"
  } | "${PSQL[@]}" >/dev/null
done

echo
"${PSQL[@]}" -c "SELECT filename, applied_at FROM stellar.schema_migration ORDER BY filename;"
