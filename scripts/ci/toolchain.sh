#!/usr/bin/env bash
# Installs or verifies Clockgrove's pinned system toolchain on Ubuntu 26.04 amd64: the GitHub
# runner and developer machines.
# A component whose exact pinned identity is present is only verified. A missing or different
# one is installed, then verified again.
#
# Usage: scripts/ci/toolchain.sh [--check] component...
#        scripts/ci/toolchain.sh --pgvector-key
#   components: postgresql pgvector opentofu opentofu-providers browser-deps browser
#   --check     verify only; exit 1 when any component is missing or different.
#   --pgvector-key  print the cache key of a staged pgvector build (see PGVECTOR_STAGE).
# browser-deps installs the system packages the lockfile's Playwright Chromium needs, with sudo;
# it needs no `pnpm install`. browser fetches that Chromium into the user's Playwright cache, with
# no sudo: run it from the repository root after `pnpm install --frozen-lockfile --ignore-scripts`.
# opentofu-providers fills a filesystem mirror of the providers that
# infra/opentofu/.terraform.lock.hcl pins, at <prefix>/share/opentofu-providers beside the `tofu`
# on PATH, so `infra:validate` installs them without network. Every zip must carry a lock-file hash.
set -euo pipefail

POSTGRESQL_DEB_VERSION='18.6-1.pgdg26.04+2'
# postgresql-server-dev-18 (with its clang and llvm) is only for compiling pgvector. It is
# skipped when a verified staged build will be reused (see postgresql_packages). pg_config itself
# ships in postgresql-client-18.
POSTGRESQL_PACKAGES=(postgresql-18 postgresql-client-18)
POSTGRESQL_DEV_PACKAGE='postgresql-server-dev-18'
PGVECTOR_VERSION='0.8.7'
PGVECTOR_COMMIT='f37c13f68b57d2c3472b2214fbcff699d6d34876'
PGVECTOR_SHA256='83d673c3b287cddbf3879f86215f043f2c2b56c69d37b2a77504910db1ed6e56'
OPENTOFU_VERSION='1.13.1'
OPENTOFU_ARCHIVE_SHA256='8ccbc6f8ee21d2827715f3c6e08a9b3e0209b1e62057c05067ef117e047c1a80'
OPENTOFU_BINARY_SHA256='a325c8c2f6834575e440b03c2ba67f94256072754ac7787fea718be6f01fef6a'

PG_CONFIG='/usr/lib/postgresql/18/bin/pg_config'
# The pg_config --pkglibdir and --sharedir of the pinned package, so a staged build is checked
# before PostgreSQL is installed.
PG_LIBDIR='/usr/lib/postgresql/18/lib'
PG_SHAREDIR='/usr/share/postgresql/18'
# Set by the main program: true when pgvector is requested and its staged build will be reused.
STAGE_REUSED=false
TOFU='/usr/local/bin/tofu'
# Records what was built from the verified pgvector source, so a later run can verify it.
PGVECTOR_STAMP='/usr/local/share/clockgrove-toolchain/pgvector'
SCRIPT_DIRECTORY="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

note() { printf 'toolchain: %s\n' "$*" >&2; }

as_root() {
  if [[ $EUID -eq 0 ]]; then "$@"; else sudo "$@"; fi
}

# A transient network failure retries the transfer only, at most three times. curl empties the
# output file before each retry, so no partial attempt is kept and every checksum still runs on
# the finished file. Downloads write files, not pipes: output already piped cannot be taken back.
CURL_RETRY=(--retry 3 --retry-all-errors --retry-delay 2)

download() {
  curl --fail --silent --show-error --location "${CURL_RETRY[@]}" "$1" --output "$2"
}

verify_sha256() {
  echo "$1  $2" | sha256sum --check --strict --quiet -
}

sha256_of() {
  local digest
  digest="$(sha256sum "$1")" || return 1
  printf '%s' "${digest%% *}"
}

# Verification functions run in `if` conditions, where errexit is off: every check returns.

pg_config_matches() {
  local banner
  banner="$("$PG_CONFIG" --version 2>/dev/null)" || return 1
  [[ "$banner" =~ ^PostgreSQL\ ([0-9]+\.[0-9]+)(\ \(Ubuntu\ 18\.6-1\.pgdg26\.04\+2\))?$ ]] || {
    note "unrecognized pg_config version banner: $banner"
    return 1
  }
  [[ "${BASH_REMATCH[1]}" == '18.6' ]]
}

postgresql_packages() {
  printf '%s\n' "${POSTGRESQL_PACKAGES[@]}"
  $STAGE_REUSED || printf '%s\n' "$POSTGRESQL_DEV_PACKAGE"
}

postgresql_present() {
  local package
  while read -r package; do
    [[ "$(dpkg-query --show --showformat='${db:Status-Status} ${Version}' "$package" 2>/dev/null)" \
      == "installed $POSTGRESQL_DEB_VERSION" ]] || return 1
  done < <(postgresql_packages)
  pg_config_matches
}

install_postgresql() {
  local package packages=() key
  as_root install -d -m 0755 /usr/share/postgresql-common/pgdg
  key="$(mktemp)"
  curl --fail --silent --show-error "${CURL_RETRY[@]}" https://www.postgresql.org/media/keys/ACCC4CF8.asc --output "$key"
  as_root install -m 0644 "$key" /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc
  rm -f "$key"
  echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt $(. /etc/os-release && echo "$VERSION_CODENAME")-pgdg main" |
    as_root tee /etc/apt/sources.list.d/pgdg.list >/dev/null
  as_root apt-get update
  while read -r package; do packages+=("$package=$POSTGRESQL_DEB_VERSION"); done < <(postgresql_packages)
  as_root env DEBIAN_FRONTEND=noninteractive apt-get install --yes --no-install-recommends \
    --allow-downgrades "${packages[@]}"
  # The runner starts the packaged cluster; tests own their clusters.
  as_root systemctl stop postgresql.service 2>/dev/null || true
}

pgvector_identity() {
  local library_digest
  library_digest="$(sha256_of "$1")" || return 1
  printf 'commit=%s source-sha256=%s library-sha256=%s' \
    "$PGVECTOR_COMMIT" "$PGVECTOR_SHA256" "$library_digest"
}

pgvector_present() {
  local library control identity
  library="$("$PG_CONFIG" --pkglibdir 2>/dev/null)/vector.so" || return 1
  control="$("$PG_CONFIG" --sharedir 2>/dev/null)/extension/vector.control" || return 1
  [[ -f "$library" && -f "$control" && -f "$PGVECTOR_STAMP" ]] || return 1
  grep -qx "default_version = '$PGVECTOR_VERSION'" "$control" || return 1
  identity="$(pgvector_identity "$library")" || return 1
  [[ "$(cat "$PGVECTOR_STAMP")" == "$identity" ]]
}

# A staged build (`make install DESTDIR=<stage>/root` plus `<stage>/stamp`) is reused only when its
# stamp names the pinned commit and source digest and its library has the stamped digest.
pgvector_stage_valid() {
  local library="$1/root$PG_LIBDIR/vector.so"
  local control="$1/root$PG_SHAREDIR/extension/vector.control"
  local identity
  [[ -f "$library" && -f "$control" && -f "$1/stamp" ]] || return 1
  grep -qx "default_version = '$PGVECTOR_VERSION'" "$control" || return 1
  identity="$(pgvector_identity "$library")" || return 1
  [[ "$(cat "$1/stamp")" == "$identity" ]]
}

build_pgvector() {
  local directory
  directory="$(mktemp -d)"
  download "https://codeload.github.com/pgvector/pgvector/tar.gz/$PGVECTOR_COMMIT" "$directory/source.tar.gz"
  verify_sha256 "$PGVECTOR_SHA256" "$directory/source.tar.gz"
  tar -xzf "$directory/source.tar.gz" --strip-components=1 -C "$directory"
  grep -qx "default_version = '$PGVECTOR_VERSION'" "$directory/vector.control"
  make -C "$directory" PG_CONFIG="$PG_CONFIG" OPTFLAGS=""
  rm -rf "$1"
  mkdir -p "$1/root"
  make -C "$directory" PG_CONFIG="$PG_CONFIG" OPTFLAGS="" DESTDIR="$1/root" install
  rm -rf "$directory"
  pgvector_identity "$1/root$("$PG_CONFIG" --pkglibdir)/vector.so" >"$1/stamp"
}

# PGVECTOR_STAGE names a directory that keeps the staged build, for a CI cache to restore.
install_pgvector() {
  local stage="${PGVECTOR_STAGE:-}" owned=false
  postgresql_present || {
    note "pgvector needs the pinned PostgreSQL; run the postgresql component first"
    return 1
  }
  if [[ -z "$stage" ]]; then
    stage="$(mktemp -d)"
    owned=true
  fi
  if pgvector_stage_valid "$stage"; then
    note "pgvector: installing the verified staged build"
  else
    build_pgvector "$stage"
  fi
  as_root cp -R "$stage/root/." /
  as_root install -d -m 0755 "$(dirname "$PGVECTOR_STAMP")"
  pgvector_identity "$("$PG_CONFIG" --pkglibdir)/vector.so" | as_root tee "$PGVECTOR_STAMP" >/dev/null
  if $owned; then rm -rf "$stage"; fi
}

opentofu_present() {
  [[ -x "$TOFU" ]] || return 1
  [[ "$(sha256_of "$TOFU")" == "$OPENTOFU_BINARY_SHA256" ]]
}

install_opentofu() {
  local directory archive="tofu_${OPENTOFU_VERSION}_linux_amd64.zip"
  directory="$(mktemp -d)"
  download "https://github.com/opentofu/opentofu/releases/download/v$OPENTOFU_VERSION/$archive" "$directory/$archive"
  verify_sha256 "$OPENTOFU_ARCHIVE_SHA256" "$directory/$archive"
  unzip -q "$directory/$archive" tofu -d "$directory/bin"
  as_root install -m 0755 "$directory/bin/tofu" "$TOFU"
  rm -rf "$directory"
}

# The mirror lives in the prefix of the `tofu` on PATH, so whatever can run that tofu reads it.
REPOSITORY="$(cd "$SCRIPT_DIRECTORY/../.." && pwd)"
TOFU_LOCK="$REPOSITORY/infra/opentofu/.terraform.lock.hcl"
OPENTOFU_PLATFORM='linux_amd64'

provider_mirror() {
  local tofu
  tofu="$(command -v tofu)" || return 1
  tofu="$(readlink -f "$tofu")" || return 1
  printf '%s/share/opentofu-providers' "$(dirname "$(dirname "$tofu")")"
}

# One "<source> <version>" line per provider the lock file pins.
locked_providers() {
  sed -nE 's/^provider "([^"]+)" \{$/\1/p; s/^  version += "([^"]+)"$/\1/p' "$TOFU_LOCK" | paste -d' ' - -
}

opentofu_providers_present() {
  local mirror source version zip digest
  mirror="$(provider_mirror)" || return 1
  while read -r source version; do
    zip="$mirror/$source/terraform-provider-${source##*/}_${version}_${OPENTOFU_PLATFORM}.zip"
    digest="$(sha256_of "$zip" 2>/dev/null)" || return 1
    grep -qF "\"zh:$digest\"" "$TOFU_LOCK" || return 1
  done < <(locked_providers)
}

install_opentofu_providers() {
  local mirror directory
  mirror="$(provider_mirror)" || {
    note "opentofu-providers needs tofu on PATH; run the opentofu component first"
    return 1
  }
  directory="$(mktemp -d)"
  mkdir "$directory/home" "$directory/config"
  cp "$REPOSITORY"/infra/opentofu/*.tf "$TOFU_LOCK" "$directory/config/"
  # Only the public registry: no user CLI config, mirrors or caches feed the mirror.
  printf 'provider_installation {\n  direct {}\n}\n' >"$directory/tofurc"
  env -i PATH="$PATH" HOME="$directory/home" TMPDIR="$directory" \
    TF_CLI_CONFIG_FILE="$directory/tofurc" TF_DATA_DIR="$directory/data" CHECKPOINT_DISABLE=1 \
    tofu -chdir="$directory/config" providers mirror -platform="$OPENTOFU_PLATFORM" "$directory/mirror"
  local write=()
  { mkdir -p "$(dirname "$mirror")" 2>/dev/null && [[ -w "$(dirname "$mirror")" ]]; } || write=(as_root)
  "${write[@]}" rm -rf "$mirror"
  "${write[@]}" cp -R "$directory/mirror" "$mirror"
  rm -rf "$directory"
}

PNPM_LOCK="$REPOSITORY/pnpm-lock.yaml"

# The version of package $1 that the workspace root resolves in pnpm-lock.yaml (its last document).
locked_version() {
  awk -v entry="      $1:" '
    /^[^ ]/ { importers = ($0 == "importers:"); root = 0; want = 0; next }
    importers && /^  [^ ]/ { root = ($0 == "  .:"); want = 0; next }
    root && $0 == entry { want = 1; next }
    want && /^        [^ ]/ { if ($1 == "version:") { version = $2; want = 0 }; next }
    { want = 0 }
    END { if (version == "") exit 1; print version }' "$PNPM_LOCK"
}

# The integrity pnpm-lock.yaml records for the package $1 (name@version).
locked_integrity() {
  awk -v entry="  $1:" '
    $0 == entry && getline > 0 && match($0, /\{integrity: sha512-[A-Za-z0-9+\/=]+\}/) {
      integrity = substr($0, RSTART + 12, RLENGTH - 13)
    }
    END { if (integrity == "") exit 1; print integrity }' "$PNPM_LOCK"
}

# The directory whose node_modules holds the lockfile's Playwright, set by pinned_playwright: the
# repository after `pnpm install`, else a private npm install of that exact version (setup runs on
# a clean tree, before `pnpm install`) whose every package carries the lockfile's integrity.
PLAYWRIGHT_ROOT=''
PLAYWRIGHT_FETCHED=''
trap 'if [[ -n "$PLAYWRIGHT_FETCHED" ]]; then rm -rf "$PLAYWRIGHT_FETCHED"; fi' EXIT

pinned_playwright() {
  local version directory fetched key integrity
  [[ -z "$PLAYWRIGHT_ROOT" ]] || return 0
  version="$(locked_version playwright)" && [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || {
    note "browser: pnpm-lock.yaml pins no playwright version for the workspace root"
    return 1
  }
  if [[ "$(node -p 'require(process.argv[1]).version' "$REPOSITORY/node_modules/playwright/package.json" 2>/dev/null)" == "$version" ]]; then
    PLAYWRIGHT_ROOT="$REPOSITORY"
    return 0
  fi
  directory="$(mktemp -d)"
  PLAYWRIGHT_FETCHED="$directory"
  printf '{"private":true,"dependencies":{"playwright":"%s"}}\n' "$version" >"$directory/package.json"
  (cd "$directory" && npm install --ignore-scripts --no-audit --no-fund --no-update-notifier --loglevel=error \
    --cache="$directory/.npm-cache" >&2) || return 1
  # One "name@version integrity" line per package npm placed.
  fetched="$(node -e '
    for (const [where, entry] of Object.entries(require(process.argv[1]).packages))
      console.log(`${where.slice(where.lastIndexOf("node_modules/") + 13)}@${entry.version} ${entry.integrity}`);
  ' "$directory/node_modules/.package-lock.json")" || return 1
  [[ $'\n'"$fetched" == *$'\n'"playwright@$version "* ]] || {
    note "browser: npm did not fetch playwright@$version"
    return 1
  }
  while read -r key integrity; do
    [[ "$integrity" == "$(locked_integrity "$key")" ]] || {
      note "browser: npm fetched $key without the integrity pnpm-lock.yaml records"
      return 1
    }
  done <<<"$fetched"
  PLAYWRIGHT_ROOT="$directory"
}

# The system packages are present when the pinned Chromium already launches for this user (its
# native libraries load), or when Playwright's own apt simulation finds none of them missing.
browser_deps_present() {
  pinned_playwright || return 1
  (cd "$PLAYWRIGHT_ROOT" && node "$SCRIPT_DIRECTORY/browser-toolchain.mjs" 2>/dev/null) && return 0
  node "$PLAYWRIGHT_ROOT/node_modules/playwright/cli.js" install-deps --dry-run chromium >&2
}

# Playwright runs apt-get itself, through sudo when this user is not root.
install_browser_deps() {
  pinned_playwright
  node "$PLAYWRIGHT_ROOT/node_modules/playwright/cli.js" install-deps chromium
}

browser_present() {
  node "$SCRIPT_DIRECTORY/browser-toolchain.mjs"
}

# The browser only: its system packages are browser-deps, so this needs no sudo.
install_browser() {
  pnpm exec playwright install chromium
}

usage() {
  sed -n '2,17p' "${BASH_SOURCE[0]}" >&2
  exit 2
}

# The cache key of a staged pgvector build: the pinned pgvector and PostgreSQL identities.
if [[ "${1:-}" == '--pgvector-key' ]]; then
  printf 'pgvector-%s-%s-postgresql-%s\n' "$PGVECTOR_VERSION" "$PGVECTOR_COMMIT" "$POSTGRESQL_DEB_VERSION"
  exit 0
fi

check_only=false
if [[ "${1:-}" == '--check' ]]; then
  check_only=true
  shift
fi
[[ $# -gt 0 ]] || usage
for component in "$@"; do
  case "$component" in
    postgresql | pgvector | opentofu | opentofu-providers | browser-deps | browser) ;;
    *) usage ;;
  esac
done

# Without server-dev the staged build must be reused, so decide before anything is installed.
if [[ " $* " == *' pgvector '* && -n "${PGVECTOR_STAGE:-}" ]] && pgvector_stage_valid "$PGVECTOR_STAGE"; then
  STAGE_REUSED=true
fi

failed=0
for component in "$@"; do
  function_name="${component//-/_}"
  if "${function_name}_present"; then
    note "$component: pinned version present"
  elif $check_only; then
    note "$component: missing or not the pinned version"
    failed=1
    continue
  else
    note "$component: installing the pinned version"
    "install_$function_name"
    if ! "${function_name}_present"; then
      note "$component: installed, but the pinned version does not verify"
      exit 1
    fi
    note "$component: installed and verified"
  fi
  if [[ "$component" == 'postgresql' && -n "${GITHUB_PATH:-}" ]]; then
    dirname "$PG_CONFIG" >>"$GITHUB_PATH"
  fi
done
exit "$failed"
