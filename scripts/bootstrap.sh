#!/bin/sh
# Download and exec the native Tavily MCP server from a GitHub Release.
#
# IMPORTANT: the inline MCP launch form is
#   sh -c 'eval "$(curl -fsSL https://github.com/<owner>/<repo>/releases/latest/download/bootstrap.sh)"'
# The eval command substitution loads the script into memory and leaves stdin
# untouched for the JSON-RPC channel. A literal `curl ... | sh` pipe instead
# feeds the script through stdin and would steal the MCP channel.
#
# Version policy: when TAVILY_MCP_VERSION is empty (default) the script probes
# the latest release through the releases/latest 302 redirect (no api.github.com
# quota is consumed) and installs it on first sight; offline launches reuse the
# last installed version. Set TAVILY_MCP_VERSION=vX.Y.Z to pin a release.

set -eu

REPOSITORY="${TAVILY_MCP_REPOSITORY:-spraylee/tavily-mcp-multi-key}"
VERSION="${TAVILY_MCP_VERSION:-}"
LATEST_PROBE_URL="${TAVILY_MCP_LATEST_PROBE_URL:-https://github.com/${REPOSITORY}/releases/latest/download/SHA256SUMS}"
CACHE_ROOT="${TAVILY_MCP_CACHE_DIR:-${XDG_CACHE_HOME:-${HOME:-.}/.cache}/spraylee/tavily-mcp-multi-key}"
FORCE_DOWNLOAD="${TAVILY_MCP_FORCE_DOWNLOAD:-0}"
OFFLINE="${TAVILY_MCP_OFFLINE:-0}"

fail() {
  printf '%s\n' "[tavily-mcp-multi-key] bootstrap: $*" >&2
  exit 1
}

command -v curl >/dev/null 2>&1 || fail "curl is required to download the native binary"
command -v uname >/dev/null 2>&1 || fail "uname is required to detect the platform"
command -v tar >/dev/null 2>&1 || fail "tar is required to extract the release archive"
command -v awk >/dev/null 2>&1 || fail "awk is required to read SHA256SUMS"

OS=$(uname -s)
ARCH=$(uname -m)
case "${OS}:${ARCH}" in
  Darwin:arm64|Darwin:aarch64)
    TARGET="aarch64-apple-darwin"
    ;;
  Darwin:x86_64|Darwin:amd64)
    TARGET="x86_64-apple-darwin"
    ;;
  Linux:x86_64|Linux:amd64)
    TARGET="x86_64-unknown-linux-gnu"
    ;;
  Linux:aarch64|Linux:arm64)
    TARGET="aarch64-unknown-linux-gnu"
    ;;
  *)
    fail "unsupported platform ${OS}/${ARCH}; build from source or use the remote HTTP MCP"
    ;;
esac

# ---- version resolution: pin or auto-follow latest ----

validate_version() {
  if ! printf '%s\n' "$VERSION" | awk \
    '/^v[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*([-.][0-9A-Za-z.-]+)?$/ { found = 1 } END { exit !found }'; then
    fail "invalid release version: $VERSION (expected vMAJOR.MINOR.PATCH)"
  fi
}

query_latest_version() {
  redirect=$(curl -fsS -o /dev/null -w '%{redirect_url}' "$LATEST_PROBE_URL" 2>/dev/null || true)
  [ -n "$redirect" ] || return 0
  printf '%s\n' "$redirect" |
    grep -oE 'releases/download/v[0-9]+\.[0-9]+\.[0-9]+[^/]*/' |
    grep -oE 'v[0-9]+\.[0-9]+\.[0-9]+([-.][0-9A-Za-z.-]+)?'
}

resolve_version() {
  if [ -n "$VERSION" ]; then
    validate_version
    return
  fi

  VERSION=$(query_latest_version)
  if [ -n "$VERSION" ]; then
    validate_version
    return
  fi

  # Probe unreachable (offline/proxy down): reuse the last installed version.
  last_version_file="${CACHE_ROOT}/last-version"
  if [ -r "$last_version_file" ]; then
    VERSION=$(awk 'NR == 1 { print $1; exit }' "$last_version_file")
  fi
  if [ -n "$VERSION" ]; then
    validate_version
    return
  fi
  fail "cannot determine the latest release and no cached version exists (${LATEST_PROBE_URL})"
}

resolve_version

ASSET="tavily-mcp-multi-key-${VERSION}-${TARGET}.tar.gz"
RELEASE_BASE_URL="${TAVILY_MCP_RELEASE_BASE_URL:-https://github.com/${REPOSITORY}/releases/download/${VERSION}}"
RELEASE_BASE_URL="${RELEASE_BASE_URL%/}"
CACHE_DIR="${CACHE_ROOT}/${VERSION}/${TARGET}"
BINARY="${CACHE_DIR}/tavily-mcp-multi-key"
CHECKSUM_FILE="${CACHE_DIR}/tavily-mcp-multi-key.sha256"
LOCK_DIR="${CACHE_DIR}/.download.lock"
LOCK_PID_FILE="${LOCK_DIR}/pid"
TEMP_DIR=""
LOCK_HELD=0

cleanup() {
  if [ -n "$TEMP_DIR" ]; then
    rm -rf "$TEMP_DIR"
  fi
  if [ "$LOCK_HELD" -eq 1 ]; then
    rm -f "$LOCK_PID_FILE"
    rmdir "$LOCK_DIR" 2>/dev/null || true
  fi
}
trap cleanup EXIT HUP INT TERM

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    fail "sha256sum or shasum is required to verify the release"
  fi
}

cache_is_valid() {
  [ -x "$BINARY" ] || return 1
  # A manually provisioned binary remains usable, but every binary downloaded
  # by this script gets a sidecar digest and is checked on every launch.
  [ -f "$CHECKSUM_FILE" ] || return 0
  expected=$(awk 'NR == 1 { print $1; exit }' "$CHECKSUM_FILE")
  case "$expected" in
    ''|*[!0-9a-fA-F]*) return 1 ;;
  esac
  expected=$(printf '%s' "$expected" | tr 'A-F' 'a-f')
  actual=$(sha256_file "$BINARY") || return 1
  [ "$actual" = "$expected" ]
}

download() {
  url="$1"
  output="$2"
  case "$url" in
    https://*)
      curl -fsSL --retry 3 --retry-delay 1 -o "$output" "$url"
      ;;
    *)
      # Used by local integration tests and private mirrors. The public
      # default remains HTTPS-only through the branch above.
      curl -fsSL --retry 3 --retry-delay 1 -o "$output" "$url"
      ;;
  esac
}

install_release() {
  [ "$OFFLINE" = "1" ] && fail "${BINARY} is not cached and TAVILY_MCP_OFFLINE=1"

  mkdir -p "$CACHE_DIR"
  attempts=0
  while ! mkdir "$LOCK_DIR" 2>/dev/null; do
    if [ -r "$LOCK_PID_FILE" ]; then
      lock_pid=$(awk 'NR == 1 { print $1; exit }' "$LOCK_PID_FILE")
      case "$lock_pid" in
        ''|*[!0-9]*) ;;
        *)
          if [ "$lock_pid" != "$$" ] && ! kill -0 "$lock_pid" 2>/dev/null; then
            rm -f "$LOCK_PID_FILE"
            rmdir "$LOCK_DIR" 2>/dev/null || true
          fi
          ;;
      esac
    fi
    attempts=$((attempts + 1))
    [ "$attempts" -le 300 ] || fail "timed out waiting for another download: $LOCK_DIR"
    sleep 0.1
  done
  LOCK_HELD=1
  printf '%s\n' "$$" > "$LOCK_PID_FILE"

  # The lock guarantees exclusivity: any .download.* directory other than a
  # fresh one is debris from a killed process. Clean it while we hold the lock.
  # (The lock dir itself must be matched first: .download.lock also matches
  # the .download.* glob.)
  for debris in "${CACHE_DIR}"/.download.*; do
    case "$debris" in
      */.download.lock) ;;
      */.download.*) rm -rf "$debris" ;;
      *) ;;
    esac
  done

  # Another MCP instance may have completed the download while we waited.
  if [ "$FORCE_DOWNLOAD" != "1" ] && cache_is_valid; then
    return 0
  fi

  TEMP_DIR="${CACHE_DIR}/.download.$$"
  mkdir "$TEMP_DIR"
  archive="${TEMP_DIR}/${ASSET}"
  checksums="${TEMP_DIR}/SHA256SUMS"
  extracted="${TEMP_DIR}/extracted"

  printf '%s\n' "[tavily-mcp-multi-key] downloading ${VERSION} (${TARGET})" >&2
  download "${RELEASE_BASE_URL}/${ASSET}" "$archive" \
    || fail "download failed: ${RELEASE_BASE_URL}/${ASSET}"
  download "${RELEASE_BASE_URL}/SHA256SUMS" "$checksums" \
    || fail "checksum download failed: ${RELEASE_BASE_URL}/SHA256SUMS"

  expected=$(awk -v name="$ASSET" '$2 == name || $2 == ("*" name) { print $1; exit }' "$checksums")
  [ -n "$expected" ] || fail "SHA256SUMS has no entry for ${ASSET}"
  case "$expected" in
    *[!0-9a-fA-F]*) fail "invalid checksum for ${ASSET}" ;;
  esac
  expected=$(printf '%s' "$expected" | tr 'A-F' 'a-f')
  actual=$(sha256_file "$archive")
  [ "$actual" = "$expected" ] || fail "checksum mismatch for ${ASSET}"

  mkdir "$extracted"
  tar -xzf "$archive" -C "$extracted" tavily-mcp-multi-key
  candidate="${extracted}/tavily-mcp-multi-key"
  [ -f "$candidate" ] || fail "release archive does not contain tavily-mcp-multi-key"
  chmod 755 "$candidate"

  # Same-filesystem rename makes the installed binary appear atomically.
  binary_digest=$(sha256_file "$candidate")
  cp "$candidate" "${BINARY}.new"
  chmod 755 "${BINARY}.new"
  printf '%s  %s\n' "$binary_digest" "tavily-mcp-multi-key" > "${CHECKSUM_FILE}.new"
  mv -f "${BINARY}.new" "$BINARY"
  mv -f "${CHECKSUM_FILE}.new" "$CHECKSUM_FILE"

  # Auto-follow mode keeps exactly the installed version plus whatever a
  # concurrently running host still has mapped; drop the rest of the old
  # version directories (removal of an in-use binary is fine on POSIX).
  mkdir -p "$CACHE_ROOT"
  for old_dir in "${CACHE_ROOT}"/v*/; do
    [ -d "$old_dir" ] || continue
    [ "$(basename "$old_dir")" = "$VERSION" ] || rm -rf "$old_dir" 2>/dev/null || true
  done
}

if [ "$FORCE_DOWNLOAD" = "1" ] || ! cache_is_valid; then
  install_release
fi

[ -x "$BINARY" ] || fail "native binary is not executable: ${BINARY}"

# Remember the version in use so offline launches can still resolve it.
mkdir -p "$CACHE_ROOT"
printf '%s\n' "$VERSION" > "${CACHE_ROOT}/last-version"

# Release the lock and delete the temporary download data before the
# shell is replaced. `exec` is the important part: the MCP host ends up with a
# direct Rust child, not a long-lived shell wrapper.
trap - EXIT HUP INT TERM
cleanup
exec "$BINARY" "$@"
