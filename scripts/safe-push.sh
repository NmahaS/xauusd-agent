#!/bin/bash
set -e
MSG="${1:-update}"

# Take remote versions of bot-managed files first
git fetch origin 2>/dev/null || true
git checkout origin/main -- plans/.last-run 2>/dev/null || true
git checkout origin/main -- README.md 2>/dev/null || true
git checkout origin/main -- plans/.last-update-id 2>/dev/null || true
git checkout origin/main -- cache/.sync-test 2>/dev/null || true

# Stage everything
git add .

# Commit if changes exist
if git diff --staged --quiet; then
  echo "Nothing to commit"
else
  git commit -m "$MSG"
  echo "✅ Committed: $MSG"
fi

# Push with force-with-lease (safe force push after fetch)
git push --force-with-lease
echo "✅ Pushed successfully"
