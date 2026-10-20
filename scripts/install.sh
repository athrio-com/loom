#!/bin/sh
# Installs Loom's standalone executable and puts it on PATH.
#
#   curl -fsSL https://github.com/athrio-com/loom/releases/latest/download/install.sh | sh
#
# Pass a version to install that release instead of the latest:
#
#   curl -fsSL …/install.sh | sh -s -- 0.0.13
#
# The executable goes into ~/.loom/bin, or the folder LOOM_INSTALL_DIR names, and the
# script adds that folder to PATH in your shell's profile. Pass --no-modify-path, or set
# LOOM_NO_MODIFY_PATH=1, to leave every profile alone.

set -eu

fail() {
  printf 'loom install: %s\n' "$1" >&2
  exit 1
}

version=
modify_path=yes
if [ -n "${LOOM_NO_MODIFY_PATH:-}" ]; then
  modify_path=no
fi

for argument in "$@"; do
  case $argument in
    --no-modify-path) modify_path=no ;;
    -*) fail "unknown option $argument" ;;
    *) version=${argument#v} ;;
  esac
done

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

if [ -n "$version" ]; then
  release="https://github.com/athrio-com/loom/releases/download/v$version"
else
  release="https://github.com/athrio-com/loom/releases/latest/download"
fi
release="${LOOM_DOWNLOAD:-$release}"

dir="${LOOM_INSTALL_DIR:-$HOME/.loom/bin}"

if [ -e "$dir/loom" ] || [ -L "$dir/loom" ]; then
  if [ -L "$dir/loom" ] || [ "$(head -c 2 "$dir/loom")" = '#!' ] ||
    ! "$dir/loom" --version 2>/dev/null | grep -q '^loom v'; then
    fail "$dir/loom is not a Loom executable, so the install leaves it alone; move it out of $dir, then run this again"
  fi
fi

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

mkdir -p "$dir"
chmod 755 "$work/loom"
mv "$work/loom" "$dir/loom.partial.$$"
mv "$dir/loom.partial.$$" "$dir/loom"

printf 'Installed %s at %s\n' "$("$dir/loom" --version)" "$dir/loom"

case $dir in
  "$HOME"/*) spelled="\$HOME/${dir#"$HOME"/}" ;;
  *) spelled=$dir ;;
esac

profile=
line="export PATH=\"$spelled:\$PATH\""
case $(basename "${SHELL:-sh}") in
  zsh) profile="${ZDOTDIR:-$HOME}/.zshrc" ;;
  bash)
    if [ "$system" = darwin ]; then
      for candidate in .bash_profile .bash_login .profile; do
        if [ -z "$profile" ] && [ -f "$HOME/$candidate" ]; then
          profile="$HOME/$candidate"
        fi
      done
      profile="${profile:-$HOME/.bash_profile}"
    else
      profile="$HOME/.bashrc"
    fi
    ;;
  fish)
    profile="${XDG_CONFIG_HOME:-$HOME/.config}/fish/config.fish"
    line="fish_add_path \"$spelled\""
    ;;
esac

case ":$PATH:" in
  *":$dir:"*) ;;
  *)
    if [ "$modify_path" = no ] || [ -z "$profile" ]; then
      printf "%s is not on your PATH. Add this line to your shell's profile:\n  %s\n" "$dir" "$line"
    elif [ -f "$profile" ] && grep -qF -e "$dir" -e "$spelled" "$profile"; then
      printf '%s already adds %s to PATH. Open a new terminal to use loom.\n' "$profile" "$dir"
    else
      mkdir -p "$(dirname "$profile")"
      printf '\n# Loom\n%s\n' "$line" >> "$profile"
      printf 'Added %s to PATH in %s. Open a new terminal to use loom.\n' "$dir" "$profile"
    fi
    ;;
esac

resolved() {
  target=$1
  hops=0
  while [ -L "$target" ] && [ "$hops" -lt 40 ]; do
    link=$(readlink "$target")
    case $link in
      /*) target=$link ;;
      *) target="$(dirname "$target")/$link" ;;
    esac
    hops=$((hops + 1))
  done
  printf '%s\n' "$target"
}

project_manager() {
  if [ -f "$1/bun.lock" ] || [ -f "$1/bun.lockb" ]; then
    echo bun
  elif [ -f "$1/pnpm-lock.yaml" ]; then
    echo pnpm
  elif [ -f "$1/yarn.lock" ]; then
    echo yarn
  else
    echo npm
  fi
}

recognise() {
  target=$(resolved "$1")
  case $target in
    */Cellar/*)
      described="installed by Homebrew"
      removal="brew uninstall loom"
      ;;
    */.bun/*)
      described="installed by Bun"
      removal="bun remove -g @athrio/loom"
      ;;
    */pnpm/*)
      described="installed by pnpm"
      removal="pnpm remove -g @athrio/loom"
      ;;
    */node_modules/*)
      root=${target%%/node_modules/*}
      if [ -f "$root/package.json" ]; then
        manager=$(project_manager "$root")
        described="installed by $manager in the project at $root"
        if [ "$manager" = npm ]; then
          removal="cd \"$root\" && npm uninstall @athrio/loom"
        else
          removal="cd \"$root\" && $manager remove @athrio/loom"
        fi
      else
        described="installed by npm"
        removal="npm uninstall -g @athrio/loom"
      fi
      ;;
    *)
      described="a file no installer owns"
      removal="rm \"$1\""
      ;;
  esac
}

seen=
printf '%s\n' "$PATH" | tr ':' '\n' | while IFS= read -r folder; do
  if [ -z "$folder" ] || [ ! -f "$folder/loom" ] || [ ! -x "$folder/loom" ]; then
    continue
  fi
  target=$(resolved "$folder/loom")
  case ":$seen:" in
    *":$target:"*) continue ;;
  esac
  seen="$seen:$target"
  if [ "$target" = "$dir/loom" ]; then
    continue
  fi
  recognise "$folder/loom"
  printf '\nAnother loom is on your PATH, at %s, %s. Remove it with:\n  %s\n' \
    "$folder/loom" "$described" "$removal"
done
