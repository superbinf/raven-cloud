#!/bin/sh
set -eu

runtime_secrets=/run/sentinel-runtime-secrets
install -d -m 0700 -o node -g node "$runtime_secrets"
install -d -m 0700 -o node -g node /var/lib/sentinel-cloud/data
chown node:node /var/lib/sentinel-cloud/data

if [ -n "${SENTINEL_TLS_CERT_FILE:-}" ]; then
  install -m 0600 -o node -g node "$SENTINEL_TLS_CERT_FILE" "$runtime_secrets/cloud.crt"
  export SENTINEL_TLS_CERT_FILE="$runtime_secrets/cloud.crt"
fi
if [ -n "${SENTINEL_TLS_KEY_FILE:-}" ]; then
  install -m 0600 -o node -g node "$SENTINEL_TLS_KEY_FILE" "$runtime_secrets/cloud.key"
  export SENTINEL_TLS_KEY_FILE="$runtime_secrets/cloud.key"
fi

exec su -p -s /bin/sh -- node -c 'exec "$0" "$@"' "$@"
