#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: ./license-reviewer.sh [--runtime=auto|docker|podman] [--ui=web|cli] [--port=PORT] [--network=BRIDGE_NETWORK]
                             [-- classifier options]

Auto mode prefers native Linux Podman 5.3+ when available, then Docker
with Compose 2.24+. Docker web mode requires Engine 28+. Web defaults
to http://127.0.0.1:8766.
Use --port for an alternate port. Only web publishes a port. Ctrl+C stops
the reviewer. The printed URL includes the browser session token.

JSON defaults to docs/features/tts-license-ingestion/reference. Reports default
to .temp/license-reports. LICENSE_REVIEWER_JSON_DIR and LICENSE_REVIEWER_REPORT_DIR
override the host paths. The model cache persists in a named runtime volume.
Rootful Podman requires existing JSON and report directories writable by the
configured non-root UID/GID (LICENSE_REVIEWER_UID and LICENSE_REVIEWER_GID).

Pass --network for an existing bridge network and use the database service name.
For a host database use host.docker.internal (Docker) or host.containers.internal
(Podman) when its port is reachable, including the existing Fluent pod’s published
DB port. For a remote database use its reachable hostname. The reviewer uses the
API .env if present. On a remote host, forward the same port with ssh -N -L
127.0.0.1:8766:127.0.0.1:8766 USER@HOST and open the printed URL locally.
USAGE
}

reviewer_ui=web
reviewer_runtime=auto
reviewer_port=8766
while (($#)); do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --runtime|--ui|--port|--network)
      if (($# < 2)); then echo "Missing value for $1" >&2; exit 1; fi
      set -- "$1=$2" "${@:3}"
      continue
      ;;
    --runtime=*) reviewer_runtime=${1#*=} ;;
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
podman_engine=(env -u CONTAINER_HOST -u CONTAINER_CONNECTION podman --remote=false)
podman_supported() {
  [[ "$(uname -s)" == Linux ]] && command -v podman >/dev/null 2>&1 || return 1
  local version
  version="$("${podman_engine[@]}" --version 2>/dev/null)" || return 1
  [[ "$version" =~ ^podman[[:space:]]version[[:space:]]([0-9]+)\.([0-9]+)(\.|$) ]] || return 1
  local major="${BASH_REMATCH[1]}" minor="${BASH_REMATCH[2]}"
  ((10#$major > 5 || (10#$major == 5 && 10#$minor >= 3))) || return 1

  # The mount help command is local-only. The version string also exists on remote clients.
  local mount_help
  mount_help="$(LC_ALL=C "${podman_engine[@]}" container mount --help 2>/dev/null)" || return 1
  [[ "$mount_help" == *'podman container mount'* ]]
}

case "$reviewer_runtime" in
  auto)
    if podman_supported; then reviewer_runtime=podman; else reviewer_runtime=docker; fi
    ;;
  podman)
    if ! podman_supported; then
      echo 'Podman mode requires a local native Linux Podman 5.3 or later installation.' >&2
      exit 1
    fi
    ;;
  docker) ;;
  *) echo 'Select --runtime=auto, --runtime=docker, or --runtime=podman.' >&2; exit 1 ;;
esac

if [[ "$reviewer_runtime" == podman ]]; then
  printf '%s\n' 'Warning: Podman support is implemented but has not been tested with a real Podman runtime.' >&2
fi

if [[ "$reviewer_runtime" == docker ]]; then
  if ! docker compose version >/dev/null 2>&1; then
    echo 'Install native Linux Podman 5.3+ or Docker with Compose 2.24+.' >&2
    exit 1
  fi
  if [[ "$reviewer_ui" == web ]]; then
    engine_version="$(docker version --format '{{.Server.Version}}')"
    engine_major="${engine_version%%.*}"
    if [[ ! "$engine_major" =~ ^[0-9]+$ ]] || ((10#$engine_major < 28)); then
      echo 'Web mode requires Docker Engine 28 or later for loopback-only port publishing.' >&2
      exit 1
    fi
  fi
  network_engine=(docker)
else
  network_engine=("${podman_engine[@]}")
fi

network="${LICENSE_REVIEWER_NETWORK:-}"
if [[ -n "$network" && "$network" != bridge ]]; then
  if [[ "$reviewer_runtime" == podman ]]; then
    case "$network" in
      host|none|private|pasta|slirp4netns|default)
        echo 'Select an existing bridge network by name.' >&2
        exit 1
        ;;
    esac
  fi
  if [[ ! "$network" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]] ||
    [[ "$("${network_engine[@]}" network inspect --format '{{.Driver}}' -- "$network" 2>/dev/null)" != bridge ]]; then
    echo 'Select an existing bridge network by name.' >&2
    exit 1
  fi
fi

api_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
cd "$api_dir"
export LICENSE_REVIEWER_UI="$reviewer_ui" LICENSE_REVIEWER_PORT="$reviewer_port"
if [[ "$reviewer_runtime" == docker && "$(uname -s)" == Linux && "$(id -u)" != 0 ]]; then
  export LICENSE_REVIEWER_UID="${LICENSE_REVIEWER_UID:-$(id -u)}"
  export LICENSE_REVIEWER_GID="${LICENSE_REVIEWER_GID:-$(id -g)}"
fi
if [[ "$reviewer_runtime" == podman ]]; then
  reviewer_uid="${LICENSE_REVIEWER_UID:-1000}"
  reviewer_gid="${LICENSE_REVIEWER_GID:-1000}"
  if [[ ! "$reviewer_uid" =~ ^[1-9][0-9]*$ || ! "$reviewer_gid" =~ ^(0|[1-9][0-9]*)$ ]]; then
    echo 'Set a nonzero numeric LICENSE_REVIEWER_UID and numeric LICENSE_REVIEWER_GID.' >&2
    exit 1
  fi
  if [[ "$(id -u)" == 0 ]]; then
    userns=host
    network="${network:-bridge}"
  else
    userns="keep-id:uid=$reviewer_uid,gid=$reviewer_gid"
    network="${network:-pasta}"
  fi

fi

reports_path="${LICENSE_REVIEWER_REPORT_DIR:-./.temp/license-reports}"
if [[ "$reviewer_runtime" == podman && "$userns" == host && ! -d "$reports_path" ]]; then
  printf 'Create the rootful Podman report directory writable by UID %s and GID %s: %s\n' \
    "$reviewer_uid" "$reviewer_gid" "$reports_path" >&2
  exit 1
fi
mkdir -p -- "$reports_path"
export LICENSE_REVIEWER_REPORT_DIR="$(cd -- "$reports_path" && pwd -P)"
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

if [[ "$reviewer_runtime" == podman ]]; then
  json_target=docs/features/tts-license-ingestion/reference
  json_dir="$(cd -- "${LICENSE_REVIEWER_JSON_DIR:-$json_target}" && pwd -P)"
  if [[ "$json_dir" == *:* || "$LICENSE_REVIEWER_REPORT_DIR" == *:* ]]; then
    echo 'Podman JSON and report directory paths cannot contain a colon.' >&2
    exit 1
  fi
  json_label='' reports_label=''
  # Relabel only the default reviewer directories, never an arbitrary bind override.
  [[ "$json_dir" == "$api_dir/$json_target" ]] && json_label=:z
  [[ "$LICENSE_REVIEWER_REPORT_DIR" == "$api_dir/.temp/license-reports" ]] && reports_label=:z

  env_file="${LICENSE_REVIEWER_ENV_FILE:-.env}"
  image=localhost/fluent-license-reviewer:latest
  run=(run --rm --init --sig-proxy=true --stop-timeout=120 --read-only
    --security-opt=no-new-privileges --cap-drop=ALL --tmpfs /tmp
    "--userns=$userns" "--user=$reviewer_uid:$reviewer_gid" "--network=$network"
    --volume "$json_dir:/app/$json_target$json_label"
    --volume "$LICENSE_REVIEWER_REPORT_DIR:/reports$reports_label"
    --volume fluent-license-reviewer-model-cache:/cache
    --entrypoint /usr/local/bin/node)
  if [[ -e "$env_file" ]]; then run+=(--env-file "$env_file"); fi
  run+=(--env HOME=/tmp --env NODE_ENV=production --env XDG_CACHE_HOME=/cache
    --env LICENSE_REVIEWER_CONTAINER=1 --env LICENSE_REVIEWER_ENGINE=Podman
    --env "LICENSE_REVIEWER_UI=$reviewer_ui" --env "LICENSE_REVIEWER_PORT=$reviewer_port"
    --env "LICENSE_REVIEWER_HOST_REPORTS=$LICENSE_REVIEWER_HOST_REPORTS")
  if [[ "${DATABASE_URL+x}" ]]; then run+=(--env DATABASE_URL); fi
  if [[ -t 0 && -t 1 ]]; then
    run+=(--interactive --tty)
  elif [[ "$reviewer_ui" == cli ]]; then
    run+=(--interactive)
  fi
  if [[ "$reviewer_ui" == web ]]; then run+=(--publish "127.0.0.1:$reviewer_port:$reviewer_port"); fi

  "${podman_engine[@]}" build -f Dockerfile.license-reviewer \
    --ignorefile Dockerfile.license-reviewer.dockerignore -t "$image" .
  exec "${podman_engine[@]}" "${run[@]}" --pull=never "$image" \
    dist/src/db/scripts/classify-licenses.js "$@"
fi

compose=(docker compose -f compose.license-reviewer.yaml run --rm --build --no-deps)
if [[ "$reviewer_ui" == web ]]; then
  compose+=(--service-ports)
fi
if [[ "${DATABASE_URL+x}" ]]; then
  compose+=(--env DATABASE_URL)
fi
exec "${compose[@]}" reviewer "$@"
