#!/usr/bin/env bash
set -euo pipefail

node_24_bin="${KODY_NODE_24_BIN:-$HOME/.nvm/versions/node/v24.15.0/bin}"

if [[ -x "$node_24_bin/node" ]]; then
	export PATH="$node_24_bin:$PATH"
fi

node_major="$(node -p "process.versions.node.split('.')[0]")"
if [[ "$node_major" != "24" ]]; then
	echo "Kody requires Node 24.x, but startup resolved $(node --version)." >&2
	echo "Install Node 24 or set KODY_NODE_24_BIN to its bin directory." >&2
	exit 1
fi

npm install
npm run setup:local
