#!/bin/sh
# Installs Loom's standalone executable.
#
#   curl -fsSL https://github.com/athrio-com/loom/releases/latest/download/install.sh | sh
#
# Pass a version to install that release instead of the latest:
#
#   curl -fsSL …/install.sh | sh -s -- 0.0.13
#
# LOOM_INSTALL_DIR chooses the folder, ~/.local/bin unless set.

set -eu

fail() {
  printf 'loom install: %s\n' "$1" >&2
  exit 1
}

case "$(uname -s)" in
  Darwin) system=darwin ;;
  Linux) system=linux ;;
  *) fail "there is no executable for $(uname -s); on Windows, download loom-windows-x64.exe from https://github.com/athrio-com/loom/releases" ;;
esac

case "$(uname -m)" in
  x86_64 | amd64) architecture=x64 ;;
  arm64 | aarch64) architecture=arm64 ;;
  *) fail "there is no executable for the $(uname -m) architecture" ;;
esac

if [ "$system" = darwin ] && [ "$architecture" = x64 ] &&
  [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || true)" = 1 ]; then
  architecture=arm64
fi

asset="loom-$system-$architecture.gz"

if [ $# -gt 0 ]; then
  release="https://github.com/athrio-com/loom/releases/download/v${1#v}"
else
  release="https://github.com/athrio-com/loom/releases/latest/download"
fi
release="${LOOM_DOWNLOAD:-$release}"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

curl -fsSL "$release/$asset" -o "$work/$asset" || fail "could not download $release/$asset"
curl -fsSL "$release/SHA256SUMS" -o "$work/SHA256SUMS" ||
  fail "could not download $release/SHA256SUMS"

expected=$(awk -v name="$asset" '$2 == name || $2 == "*" name { print $1 }' "$work/SHA256SUMS")
[ -n "$expected" ] || fail "SHA256SUMS lists no $asset"

if command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "$work/$asset" | awk '{ print $1 }')
else
  actual=$(shasum -a 256 "$work/$asset" | awk '{ print $1 }')
fi
[ "$actual" = "$expected" ] || fail "the checksum of $asset does not match SHA256SUMS"

gunzip -c "$work/$asset" > "$work/loom" || fail "could not unpack $asset"

dir="${LOOM_INSTALL_DIR:-$HOME/.local/bin}"
mkdir -p "$dir"
chmod 755 "$work/loom"
mv "$work/loom" "$dir/loom.partial.$$"
mv "$dir/loom.partial.$$" "$dir/loom"

printf 'Installed %s at %s\n' "$("$dir/loom" --version)" "$dir/loom"

case ":$PATH:" in
  *":$dir:"*)
    found=$(command -v loom || true)
    if [ -n "$found" ] && [ "$found" != "$dir/loom" ]; then
      printf 'Another loom comes first on your PATH, at %s\n' "$found"
    fi
    ;;
  *)
    printf '%s is not on your PATH. Add it with:\n' "$dir"
    printf '  export PATH="%s:$PATH"\n' "$dir"
    ;;
esac
