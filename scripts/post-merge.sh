#!/bin/bash
# Runs automatically after a task is merged into the main app.
#
# Merged work often brings new dependencies with it, and package.json arrives
# without the matching node_modules, which breaks the type check and the dev
# server until someone installs them. Installing here keeps the app runnable
# straight after a merge.
#
# Deliberately does not touch the database: drizzle-kit push can prompt before
# destructive changes, and this script runs with stdin closed. Schema changes
# are applied by hand so the warnings are actually read.
set -e

echo "Installing dependencies..."
npm install --no-audit --no-fund

echo "Post-merge setup finished."
