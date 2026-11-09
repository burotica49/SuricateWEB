#!/bin/sh
# Le volume monté sur DATA_DIR (Dokploy, volume Docker, bind mount) appartient souvent à root.
# On le rend accessible à l'utilisateur node, puis on abandonne les droits root.
set -e

if [ "$(id -u)" = "0" ]; then
  data="${DATA_DIR:-/data}"
  data="${data%/}"
  case "$data" in
    ""|/|/app|/usr|/bin|/sbin|/etc|/root)
      echo "DATA_DIR invalide : ${DATA_DIR:-/data}" >&2
      exit 1
      ;;
  esac
  mkdir -p "$data"
  # Répertoire non inscriptible, ou base déjà créée par root : on reprend tout le dossier.
  if ! su-exec node sh -c 'test -w "$1" && { [ ! -e "$1/suricate.db" ] || [ -w "$1/suricate.db" ]; }' sh "$data"; then
    chown -R node:node "$data"
  fi
  exec su-exec node "$@"
fi

exec "$@"
