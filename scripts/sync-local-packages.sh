#!/bin/bash
# Sync @gatesai/* local dists to the global gates installation.
# Run after building gates-effect packages to get local fixes into production.

GLOBAL=$(npm root -g)/gates
MONOREPO="/home/lucian/gates-effect/packages"

for pkg in runtime providers sandbox skills; do
  src="$MONOREPO/$pkg/dist"
  dst="$GLOBAL/node_modules/@gatesai/$pkg/dist"
  if [ -d "$src" ] && [ -d "$(dirname "$dst")" ]; then
    cp -r "$src" "$GLOBAL/node_modules/@gatesai/$pkg/"
    echo "✓ @gatesai/$pkg"
  fi
done

echo "Done. Restart gates to pick up changes."
