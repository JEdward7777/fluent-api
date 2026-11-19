#!/bin/sh
set -eu

reviewer_uid=${LICENSE_REVIEWER_UID:-1000}
reviewer_gid=${LICENSE_REVIEWER_GID:-1000}
case "$reviewer_uid" in
  ''|0*|*[!0-9]*) echo 'LICENSE_REVIEWER_UID must be a nonzero numeric user ID.' >&2; exit 1 ;;
esac
case "$reviewer_gid" in
  ''|*[!0-9]*) echo 'LICENSE_REVIEWER_GID must be a numeric group ID.' >&2; exit 1 ;;
esac

# Special network modes would escape the configured host loopback publication.
case "${LICENSE_REVIEWER_NETWORK:-bridge}" in
  host|none|*[!a-zA-Z0-9_.-]*) echo 'Select an existing Docker bridge network.' >&2; exit 1 ;;
esac

# Only the named cache volume may be initialized by the root entrypoint.
if [ "$(stat -c '%u:%g' /cache)" != "$reviewer_uid:$reviewer_gid" ]; then
  chown -Rh "$reviewer_uid:$reviewer_gid" /cache
fi

export LICENSE_REVIEWER_CONTAINER=1 LICENSE_REVIEWER_ENGINE=Docker
exec su-exec "$reviewer_uid:$reviewer_gid" node dist/src/db/scripts/classify-licenses.js "$@"
