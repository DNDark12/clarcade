#!/bin/sh
set -eu

source_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
case "${1:-}" in
  /*.mcpb) output=$1 ;;
  *) printf '%s\n' 'Usage: sh pack.sh /absolute/path/to/clarcade-chat-preview.mcpb' >&2; exit 2 ;;
esac
if [ -e "$output" ]; then
  printf '%s\n' 'The destination already exists. Choose a new output file.' >&2
  exit 2
fi
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
code_plugin="$source_dir/../clarcade"
mkdir -p "$stage/server" "$stage/clarcade/.claude-plugin" "$stage/clarcade/hooks" "$stage/clarcade/games/gomoku"
cp "$source_dir/manifest.json" "$stage/"
cp "$source_dir/server.mjs" "$source_dir/board.html" "$stage/server/"
cp "$code_plugin/package.json" "$stage/clarcade/"
cp "$code_plugin/.claude-plugin/plugin.json" "$stage/clarcade/.claude-plugin/"
cp -R "$code_plugin/helper" "$stage/clarcade/"
cp "$code_plugin/hooks/link.js" "$stage/clarcade/hooks/"
cp "$code_plugin/games/gomoku/rules.js" "$stage/clarcade/games/gomoku/"
cp "$source_dir/../../LICENSE" "$stage/"
(cd "$stage" && zip -Xq -r "$output" manifest.json LICENSE server clarcade)
unzip -tq "$output"
