#!/bin/sh
set -eu

PLUGIN_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
exec node "$PLUGIN_DIR/cli.js" "$@"
