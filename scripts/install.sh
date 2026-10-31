#!/usr/bin/env bash
# Install the Jev MCP server into a DSH home and create the key file if needed.
# Does not modify any profile config; add config/cordis.patch.example.yml yourself.
set -euo pipefail

SRC="$(cd "$(dirname "$0")/.." && pwd)"
DSH_HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
DEST="$DSH_HOME_DIR/mcp/jev"
KEY_FILE="$DSH_HOME_DIR/secrets/jev.env"

mkdir -p "$DEST"
cp -R "$SRC/lib" "$DEST/"
cp -R "$SRC/server" "$DEST/"
cp "$SRC/package.json" "$DEST/"
chmod +x "$DEST/server/jev-mcp.mjs" 2>/dev/null || true

mkdir -p "$(dirname "$KEY_FILE")"
if [ ! -f "$KEY_FILE" ]; then
  (umask 077 && printf 'TYPESAFE_API_KEY=\n' > "$KEY_FILE")
  echo "Created $KEY_FILE (mode 600). Add your TypeSafe API key."
else
  echo "Keeping existing $KEY_FILE"
fi

echo "Installed to $DEST"
echo "Next: add the mcp-jev entry from config/cordis.patch.example.yml to your profile patch, then restart DSH."
