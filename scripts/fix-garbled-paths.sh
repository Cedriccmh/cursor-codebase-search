#!/bin/bash

# Script to fix garbled paths issue by forcing a fresh re-index
# This resolves the pathKey mismatch problem described in docs/multi-codebase-investigation-zh.md

echo "🔧 Fixing Garbled Paths Issue"
echo "=============================="
echo ""
echo "This script will:"
echo "1. Backup your current state file"
echo "2. Delete the state file to force a fresh re-index"
echo "3. Re-index your workspace with a new pathKey and codebaseId"
echo ""
echo "⚠️  WARNING: This will create a new index on the server."
echo "   The old index will remain but won't be used anymore."
echo ""

# Find the state file
STATE_DIR="$HOME/.mcp-cursearch"
WORKSPACE_PATH=$(pwd)

# Convert Windows path to hash for state directory name
if [[ "$OSTYPE" == "msys" ]] || [[ "$OSTYPE" == "win32" ]]; then
  # On Windows/Git Bash
  WORKSPACE_HASH=$(echo -n "$WORKSPACE_PATH" | sha256sum | cut -c1-12)
else
  # On Unix-like systems
  WORKSPACE_HASH=$(echo -n "$WORKSPACE_PATH" | shasum -a 256 | cut -c1-12)
fi

STATE_FILE="$STATE_DIR/$WORKSPACE_HASH/state.json"

if [ ! -f "$STATE_FILE" ]; then
  echo "❌ State file not found at: $STATE_FILE"
  echo "   Nothing to fix. You can proceed with indexing."
  exit 1
fi

echo "📁 Found state file: $STATE_FILE"
echo ""

# Show current state
echo "Current state:"
cat "$STATE_FILE" | grep -E "(codebaseId|pathKey|pathKeyHash)" || cat "$STATE_FILE"
echo ""

read -p "Do you want to proceed? (y/N) " -n 1 -r
echo ""

if [[ ! $REPLY =~ ^[Yy]$ ]]; then
  echo "❌ Aborted."
  exit 1
fi

# Backup the state file
BACKUP_FILE="$STATE_FILE.backup.$(date +%Y%m%d_%H%M%S)"
echo "📦 Backing up state file to: $BACKUP_FILE"
cp "$STATE_FILE" "$BACKUP_FILE"

# Delete the state file
echo "🗑️  Deleting state file..."
rm "$STATE_FILE"

echo ""
echo "✅ State file deleted successfully!"
echo ""
echo "Next steps:"
echo "1. Run the index command to create a fresh index:"
echo "   npm run index"
echo "   or"
echo "   mcp-cursearch index-activate \"$WORKSPACE_PATH\""
echo ""
echo "2. After re-indexing, test the search to verify paths are correct:"
echo "   npm run test:search"
echo ""
echo "If you need to restore the old state, you can copy back the backup:"
echo "   cp \"$BACKUP_FILE\" \"$STATE_FILE\""
echo ""

