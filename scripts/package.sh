#!/usr/bin/env bash
# Builds the extension zip reproducibly: the same commit always gives a
# byte-identical zip (fixed file order, timestamps and permissions), so anyone
# can rebuild a release and compare its SHA-256 with the published one.
#
#   scripts/package.sh [out-dir]     (default: dist)
#
# Needs: bash, git, node, zip, sha256sum (Linux, macOS with coreutils, WSL).
set -euo pipefail

cd "$(dirname "$0")/.."
out="${1:-dist}"

version=$(node -p "require('./manifest.json').version")
name="xiaopin-$version"

# Timestamps come from the commit, not the clock.
export SOURCE_DATE_EPOCH="${SOURCE_DATE_EPOCH:-$(git log -1 --format=%ct)}"
export TZ=UTC
export LC_ALL=C

# Everything the extension needs at runtime, and nothing else.
FILES=(
  manifest.json background.js content.js inject.js subtitles.js
  options.html options.js overlay.css LICENSE THIRD_PARTY_NOTICES.md
)
DIRS=(lib assets icons features)

stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
mkdir -p "$stage/$name"

for f in "${FILES[@]}"; do cp "$f" "$stage/$name/"; done
for d in "${DIRS[@]}"; do [ -d "$d" ] && cp -r "$d" "$stage/$name/"; done

cat > "$stage/$name/INSTALL.txt" <<EOF
Xiaopin - Pinyin Subtitles $version

1. Open chrome://extensions (or edge://extensions, brave://extensions).
2. Turn on "Developer mode".
3. Click "Load unpacked" and select this folder.
4. Click the extension icon to add an OpenRouter or Anthropic API key
   if you want AI translation (optional).

Built from commit $(git rev-parse HEAD).
Verify this download: see "Verifying a release" in README.md.
EOF

# Normalise permissions and timestamps.
find "$stage/$name" -type d -exec chmod 755 {} +
find "$stage/$name" -type f -exec chmod 644 {} +
find "$stage/$name" -exec touch -h -d "@$SOURCE_DATE_EPOCH" {} +

mkdir -p "$out"
zip_path="$(cd "$out" && pwd)/$name.zip"
rm -f "$zip_path"
# Sorted file list, no directory entries, no extra attributes (-X).
(cd "$stage" && find "$name" -type f | sort | zip -X -D -q "$zip_path" -@)

(cd "$out" && sha256sum "$name.zip" > SHA256SUMS.txt)
echo "$zip_path"
cat "$out/SHA256SUMS.txt"
