#!/bin/sh
# Start the local ask API in Anthropic model mode (used by `pnpm dev:api:model`).
#
# The API key is read from a macOS Keychain item and is handed to this one server process
# only: it is not exported to the calling shell, not passed as a command-line argument, and
# never printed. The item name is local configuration, not part of the repository: set
# ANTHROPIC_KEYCHAIN_ITEM, or put the name on the first line of private/anthropic-keychain-item
# (gitignored).
set -eu

repo_root="$(cd "$(dirname "$0")/../../.." && pwd)"
item="${ANTHROPIC_KEYCHAIN_ITEM:-}"
if [ -z "$item" ] && [ -f "$repo_root/private/anthropic-keychain-item" ]; then
  item="$(head -n 1 "$repo_root/private/anthropic-keychain-item" | tr -d '[:space:]')"
fi
if [ -z "$item" ]; then
  echo "No Keychain item name. Set ANTHROPIC_KEYCHAIN_ITEM or write it to private/anthropic-keychain-item." >&2
  exit 1
fi

if ! key="$(security find-generic-password -s "$item" -w 2>/dev/null)" || [ -z "$key" ]; then
  echo "No Anthropic API key in the Keychain item \"$item\"." >&2
  echo "Add it once with: security add-generic-password -a \"\$USER\" -s \"$item\" -w" >&2
  echo "(The -w flag last makes security prompt for the key instead of taking it as an argument.)" >&2
  exit 1
fi

cd "$(dirname "$0")/.."

# Haiku 4.5 list prices, per million tokens. Override either variable to change the estimate.
ASK_INPUT_USD_PER_MILLION="${ASK_INPUT_USD_PER_MILLION:-1}" \
ASK_OUTPUT_USD_PER_MILLION="${ASK_OUTPUT_USD_PER_MILLION:-5}" \
LOCAL_MODEL_CONVERSATION=true \
LOCAL_MODEL_PROVIDER=anthropic \
ANTHROPIC_API_KEY="$key" \
exec uv run python dev_server.py
