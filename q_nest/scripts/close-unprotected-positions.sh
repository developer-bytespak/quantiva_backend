#!/bin/bash

# Script to close unprotected stock positions (no OCO sell orders)
# Run from project root: ./scripts/close-unprotected-positions.sh

echo "🔍 Checking for unprotected stock positions..."
echo "================================================"
echo ""

cd "$(dirname "$0")/.."

npx ts-node src/modules/alpaca-paper-trading/scripts/close-unprotected-positions.ts
