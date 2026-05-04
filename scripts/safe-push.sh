#!/bin/bash
# Safe push — handles bot commit conflicts automatically
set -e

echo "Fetching latest..."
git fetch origin

echo "Taking remote versions of bot-managed files..."
git checkout origin/main -- plans/.last-run 2>/dev/null || true
git checkout origin/main -- README.md 2>/dev/null || true
git checkout origin/main -- plans/.last-update-id 2>/dev/null || true
git checkout origin/main -- cache/.sync-test 2>/dev/null || true

echo "Staging your changes..."
git add .

echo "Committing..."
MSG="${1:-update}"
git diff --staged --quiet || git commit -m "$MSG"

echo "Pulling with rebase..."
git pull --rebase origin main

echo "Pushing..."
git push

echo "✅ Done"
