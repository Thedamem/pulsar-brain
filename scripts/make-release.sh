#!/usr/bin/env bash
# Build release archives for distribution.
#
#   scripts/make-release.sh              # пишет файлы в dist/
#   scripts/make-release.sh /tmp/out     # другой каталог
#
# Создаёт:
#   dist/pulsar_brain.zip                  HACS/manual install: custom_components/pulsar_brain
#   dist/pulsar_brain_addon_<version>.tar.gz  локальный аддон: pulsar_brain/ = содержимое addon/
#   dist/SHA256SUMS                        контрольные суммы
#
# Ничего не публикует: загрузка релиза — отдельным шагом после подтверждения владельца.
set -euo pipefail

REPO_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

OUT_DIR="${1:-$REPO_DIR/dist}"
mkdir -p "$OUT_DIR"
OUT_DIR="$(cd "$OUT_DIR" && pwd)"

MANIFEST="$REPO_DIR/custom_components/pulsar_brain/manifest.json"
ADDON_CONFIG="$REPO_DIR/addon/config.yaml"
HACS_MANIFEST="$REPO_DIR/hacs.json"

[[ -f "$MANIFEST" ]] || { echo "ОШИБКА: нет $MANIFEST" >&2; exit 1; }
[[ -f "$HACS_MANIFEST" ]] || { echo "ОШИБКА: нет $HACS_MANIFEST" >&2; exit 1; }
[[ -f "$ADDON_CONFIG" ]] || { echo "ОШИБКА: нет $ADDON_CONFIG" >&2; exit 1; }

VERSION="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["version"])' "$MANIFEST")"
ADDON_VERSION="$(python3 -c 'import re,sys;print(re.search(r"^version:\s*\"?([^\"\n]+)\"?",open(sys.argv[1]).read(),re.M).group(1))' "$ADDON_CONFIG")"

if [[ "$VERSION" != "$ADDON_VERSION" ]]; then
  echo "ОШИБКА: версии расходятся: manifest=$VERSION addon=$ADDON_VERSION" >&2
  exit 1
fi

ZIP="$OUT_DIR/pulsar_brain.zip"
ADDON_TAR="$OUT_DIR/pulsar_brain_addon_${ADDON_VERSION}.tar.gz"
rm -f "$ZIP" "$ADDON_TAR" "$OUT_DIR/SHA256SUMS"

echo "==> integration zip: $(basename "$ZIP") (v$VERSION)"
(cd "$REPO_DIR" && zip -qr "$ZIP" custom_components/pulsar_brain \
  -x '*/__pycache__/*' '*.pyc' '*.pyo' '*.pytest_cache/*')

if unzip -l "$ZIP" | grep -q '__pycache__'; then
  echo "ОШИБКА: в zip попали __pycache__" >&2
  exit 1
fi
if ! unzip -l "$ZIP" | grep -q 'custom_components/pulsar_brain/manifest.json'; then
  echo "ОШИБКА: в zip нет custom_components/pulsar_brain/manifest.json" >&2
  exit 1
fi

echo "==> addon archive: $(basename "$ADDON_TAR") (v$ADDON_VERSION)"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/pulsar_brain"
cp -a "$REPO_DIR/addon/." "$STAGE/pulsar_brain/"
rm -rf "$STAGE/pulsar_brain/node_modules" "$STAGE/pulsar_brain/web/node_modules" \
       "$STAGE/pulsar_brain/web/dist" "$STAGE/pulsar_brain/dist" \
       "$STAGE/pulsar_brain/.git" "$STAGE/pulsar_brain/.env"
(cd "$STAGE" && tar -czf "$ADDON_TAR" pulsar_brain)

(cd "$OUT_DIR" && sha256sum "$(basename "$ZIP")" "$(basename "$ADDON_TAR")" > SHA256SUMS)

echo
cat "$OUT_DIR/SHA256SUMS"
echo
echo "Готово. Ничего не опубликовано; загрузка релиза — после подтверждения владельца."
