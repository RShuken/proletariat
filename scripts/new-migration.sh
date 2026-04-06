#!/usr/bin/env bash
#
# new-migration.sh — Create a new numbered migration file and register it.
#
# Usage:
#   ./scripts/new-migration.sh <migration_name>
#   pnpm new-migration <migration_name>
#
# Example:
#   ./scripts/new-migration.sh add_user_preferences
#
# This script:
#   1. Scans existing migration files to find the highest migration number
#   2. Creates a new migration file with the next sequential number
#   3. Auto-registers the import and array entry in index.ts
#
# Designed to prevent numbering conflicts when multiple developers or agents
# add migrations in parallel — each developer runs this script to claim the
# next available number at the time of creation.

set -euo pipefail

MIGRATIONS_DIR="apps/cli/src/lib/database/migrations"

# --- Validate input ---
if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <migration_name>"
  echo "Example: $0 add_user_preferences"
  exit 1
fi

MIGRATION_NAME="$1"

# Validate name: lowercase alphanumeric + underscores only
if [[ ! "$MIGRATION_NAME" =~ ^[a-z][a-z0-9_]*$ ]]; then
  echo "Error: Migration name must be lowercase alphanumeric with underscores (e.g., add_user_preferences)"
  echo "Got: $MIGRATION_NAME"
  exit 1
fi

# --- Find next migration number ---
HIGHEST=$(ls "$MIGRATIONS_DIR"/[0-9][0-9][0-9][0-9]_*.ts 2>/dev/null \
  | sed 's|.*/||' \
  | grep -oE '^[0-9]+' \
  | sort -n \
  | tail -1)

if [[ -z "$HIGHEST" ]]; then
  HIGHEST=0
fi

NEXT_NUM=$((10#$HIGHEST + 1))
PADDED=$(printf '%04d' "$NEXT_NUM")

# --- Derive camelCase export name from snake_case ---
# e.g., add_user_preferences -> addUserPreferences
# Uses perl for portable uppercase conversion (macOS sed lacks \U)
CAMEL_NAME=$(echo "$MIGRATION_NAME" | perl -pe 's/_([a-z])/uc($1)/ge')

FILENAME="${PADDED}_${MIGRATION_NAME}.ts"
FILEPATH="${MIGRATIONS_DIR}/${FILENAME}"

# --- Check for conflicts ---
if [[ -f "$FILEPATH" ]]; then
  echo "Error: Migration file already exists: $FILEPATH"
  exit 1
fi

# --- Create migration file ---
cat > "$FILEPATH" << EOF
/**
 * Migration ${PADDED} — ${MIGRATION_NAME}
 *
 * TODO: Describe what this migration does.
 */

import type Database from 'better-sqlite3'
import type { Migration } from '../migrator.js'

export const ${CAMEL_NAME}: Migration = {
  id: '${PADDED}',
  name: '${MIGRATION_NAME}',
  up: (db: Database.Database) => {
    db.exec(\`
      -- TODO: Add your SQL here
    \`)
  },
}
EOF

echo "Created: $FILEPATH"

# --- Register in index.ts ---
INDEX_FILE="${MIGRATIONS_DIR}/index.ts"

# Find the last import line to append after it
LAST_IMPORT_LINE=$(grep -n "^import " "$INDEX_FILE" | tail -1 | cut -d: -f1)
IMPORT_STATEMENT="import { ${CAMEL_NAME} } from './${PADDED}_${MIGRATION_NAME}.js'"

# Insert the import after the last import
sed -i '' "${LAST_IMPORT_LINE}a\\
${IMPORT_STATEMENT}
" "$INDEX_FILE"

# Find the closing bracket of ALL_MIGRATIONS array and insert before it
# The array ends with a lone "]" line
ARRAY_CLOSE_LINE=$(grep -n '^]' "$INDEX_FILE" | tail -1 | cut -d: -f1)
ARRAY_ENTRY="  ${CAMEL_NAME},"

sed -i '' "$((ARRAY_CLOSE_LINE))i\\
${ARRAY_ENTRY}
" "$INDEX_FILE"

echo "Registered in: $INDEX_FILE"
echo ""
echo "Next steps:"
echo "  1. Edit $FILEPATH and add your SQL"
echo "  2. Run: cd apps/cli && pnpm build"
echo "  3. Run: cd apps/cli && pnpm test:unit"
