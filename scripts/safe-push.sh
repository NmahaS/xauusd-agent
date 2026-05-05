#!/bin/bash
# Safe push — handles concurrent bot commits automatically
set -e

MSG="${1:-update}"

echo "📦 Staging changes..."
git add .

# Check if there's anything to commit
if git diff --staged --quiet; then
  echo "Nothing to commit — just pushing..."
else
  echo "💬 Committing: $MSG"
  git commit -m "$MSG"
fi

echo "🔄 Syncing with remote..."
# Fetch latest
git fetch origin

# Take remote versions of all bot-managed files to avoid conflicts
git checkout origin/main -- plans/.last-run 2>/dev/null || true
git checkout origin/main -- README.md 2>/dev/null || true
git checkout origin/main -- plans/.last-update-id 2>/dev/null || true
git checkout origin/main -- cache/.sync-test 2>/dev/null || true

# Stage the remote versions we just took
git add plans/.last-run README.md plans/.last-update-id cache/.sync-test 2>/dev/null || true

# Rebase on top of remote
git rebase origin/main

echo "🚀 Pushing..."
# Force push with lease — safe because we just rebased on top of origin/main
# This handles the race condition where bot commits between our rebase and push
git push --force-with-lease

echo "✅ Done: $MSG"
