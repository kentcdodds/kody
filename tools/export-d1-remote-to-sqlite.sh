#!/usr/bin/env bash
# Export a remote Cloudflare D1 database to a local SQL dump and SQLite file.
#
# Prerequisites:
# - npm dependencies installed so local Wrangler is available
# - sqlite3 (macOS: preinstalled; Linux: apt install sqlite3)
# - CLOUDFLARE_API_TOKEN (and usually CLOUDFLARE_ACCOUNT_ID) in packages/worker/.env
#
# Usage:
#   ./tools/export-d1-remote-to-sqlite.sh <d1-database-name>
#
# Example (legacy DB that old wrangler.jsonc IDs pointed at):
#   ./tools/export-d1-remote-to-sqlite.sh epicflare
#
# Output (gitignored via .tmp/):
#   .tmp/d1-exports/<name>.sql
#   .tmp/d1-exports/<name>.sqlite
#
# See docs/agents/d1-legacy-export.md for copying rows into a new kody D1.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [ "${1:-}" = "" ] || [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
	echo "Usage: $0 <d1-database-name>" >&2
	echo "Example: $0 epicflare" >&2
	exit 1
fi

NAME="$1"
OUT_DIR="${D1_EXPORT_DIR:-"$ROOT/.tmp/d1-exports"}"
mkdir -p "$OUT_DIR"

if [ -f "$ROOT/packages/worker/.env" ]; then
	set -a
	# shellcheck disable=SC1091
	. "$ROOT/packages/worker/.env"
	set +a
fi

SQL_FILE="$OUT_DIR/${NAME}.sql"
DB_FILE="$OUT_DIR/${NAME}.sqlite"

echo "Exporting remote D1 \"$NAME\" to $SQL_FILE ..."
npx wrangler d1 export "$NAME" --remote --output "$SQL_FILE"

echo "Building SQLite file $DB_FILE ..."
rm -f "$DB_FILE"
sqlite3 "$DB_FILE" <"$SQL_FILE"

echo "Done."
echo "  SQL:    $SQL_FILE"
echo "  SQLite: $DB_FILE"
