#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: ./license-reviewer.sh [--ui=web|cli] [--port=PORT] [--network=BRIDGE_NETWORK]
                             [-- classifier options]

Requires Docker and Compose 2.24+. Web is the default at http://127.0.0.1:8766.
Use --port for an alternate port. Only web publishes a port. Ctrl+C stops
the reviewer. The printed URL includes the browser session token.

JSON defaults to docs/features/tts-license-ingestion/reference. Reports default
to .temp/license-reports. LICENSE_REVIEWER_JSON_DIR and LICENSE_REVIEWER_REPORT_DIR
override the host paths. The model cache persists in a Docker volume.

Pass --network for an existing Docker bridge network and use the database service name
in the connection. For a DB on the Docker host use host.docker.internal. For a
remote DB use its reachable hostname. The reviewer uses the API .env if present.
On a remote Docker host, forward the same port with ssh -N -L
127.0.0.1:8766:127.0.0.1:8766 USER@HOST and open the printed URL locally.
USAGE
}

reviewer_ui=web
reviewer_port=8766
while (($#)); do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --ui|--port|--network)
      if (($# < 2)); then echo "Missing value for $1" >&2; exit 1; fi
      set -- "$1=$2" "${@:3}"
      continue
      ;;
    --ui=*) reviewer_ui=${1#*=} ;;
    --port=*) reviewer_port=${1#*=} ;;
    --network=*) export LICENSE_REVIEWER_NETWORK="${1#*=}" ;;
    --) shift; break ;;
    *) echo "Unknown launch option $1. Put classifier options after --." >&2; exit 1 ;;
  esac
  shift
done

case "$reviewer_ui" in web|cli) ;; *) echo 'Select --ui=web or --ui=cli.' >&2; exit 1 ;; esac
if [[ ! "$reviewer_port" =~ ^[1-9][0-9]{0,4}$ ]] || ((reviewer_port > 65535)); then
  echo '--port must be an integer from 1 to 65535.' >&2
  exit 1
fi
if [[ "${LICENSE_REVIEWER_NETWORK:-bridge}" != bridge ]]; then
  if [[ ! "${LICENSE_REVIEWER_NETWORK}" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]] ||
    [[ "$(docker network inspect --format '{{.Driver}}' -- "$LICENSE_REVIEWER_NETWORK" 2>/dev/null)" != bridge ]]; then
    echo 'Select an existing Docker bridge network.' >&2
    exit 1
  fi
fi
if ! docker compose version >/dev/null 2>&1; then
  echo 'Install Docker with Compose 2.24 or later.' >&2
  exit 1
fi

api_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$api_dir"
export LICENSE_REVIEWER_UI="$reviewer_ui" LICENSE_REVIEWER_PORT="$reviewer_port"
if [[ "$(uname -s)" == Linux && "$(id -u)" != 0 ]]; then
  export LICENSE_REVIEWER_UID="${LICENSE_REVIEWER_UID:-$(id -u)}"
  export LICENSE_REVIEWER_GID="${LICENSE_REVIEWER_GID:-$(id -g)}"
fi
reports_path="${LICENSE_REVIEWER_REPORT_DIR:-./.temp/license-reports}"
mkdir -p "$reports_path"
export LICENSE_REVIEWER_REPORT_DIR="$(cd "$reports_path" && pwd -P)"
export LICENSE_REVIEWER_HOST_REPORTS="$LICENSE_REVIEWER_REPORT_DIR"
if [[ "${OS:-}" == Windows_NT ]] && command -v cygpath >/dev/null 2>&1; then
  export LICENSE_REVIEWER_REPORT_DIR="$(cygpath -am "$LICENSE_REVIEWER_REPORT_DIR")"
  export LICENSE_REVIEWER_HOST_REPORTS="$LICENSE_REVIEWER_REPORT_DIR"
  if [[ -n "${LICENSE_REVIEWER_JSON_DIR:-}" ]]; then
    export LICENSE_REVIEWER_JSON_DIR="$(cygpath -am "$LICENSE_REVIEWER_JSON_DIR")"
  fi
  if [[ -n "${LICENSE_REVIEWER_ENV_FILE:-}" ]]; then
    export LICENSE_REVIEWER_ENV_FILE="$(cygpath -am "$LICENSE_REVIEWER_ENV_FILE")"
  fi
  export MSYS2_ARG_CONV_EXCL='*'
fi

compose=(docker compose -f compose.license-reviewer.yaml run --rm --build --no-deps)
if [[ "$reviewer_ui" == web ]]; then
  compose+=(--service-ports)
fi
exec "${compose[@]}" reviewer "$@"
