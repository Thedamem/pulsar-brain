# Публикация pulsar-brain

Порядок публикации. Релизы и публикация выполняются maintainer'ом вручную; ниже — точный порядок действий.

## 1. Что куда публикуется

| Канал | Что читает | Требования |
|---|---|---|
| GitHub (публичный) | HACS / встроенный Marketplace | репозиторий публичный, `hacs.json`, `custom_components/<domain>`, `manifest.json`, `brand/` |
| Любой git (Forgejo/Gitea/GitLab) | магазин аддонов Supervisor | публичный доступ по сети, `repository.yaml` в корне, `addon/config.yaml` + `addon/Dockerfile` |
| Releases (GitHub/Forgejo) | ручная установка интеграции, HACS `zip_release` | тег `v<version>`, ассет `pulsar_brain.zip` |

HACS и Marketplace работают **только с публичным GitHub** — это ограничение их кода, не настройка
репозитория. Аддон-стор Supervisor читает любой git, включая локальный Forgejo.

## 2. Чек-лист перед публикацией

- [ ] Лицензия выбрана и добавлена файлом `LICENSE` (сейчас не выбрана).
- [ ] `custom_components/pulsar_brain/manifest.json`: версия, `codeowners`, `documentation`,
      `issue_tracker` указывают на финальный аккаунт.
- [ ] `addon/config.yaml`: версия совпадает с `manifest.json`, `arch` соответствует целевым.
- [ ] `hacs.json` на месте, `brand/icon.png` и `brand/logo.png` в каталоге интеграции.
- [ ] Секретов и приватных адресов в репозитории нет:
      `git grep -nE '192\.168\.|/home/|eyJ|gh[pousr]_|sk-[A-Za-z0-9]{20,}'`
      (внутренние ревью лежат в `docs/internal/`, каталог в `.gitignore`).
- [ ] `scripts/check-all.sh` зелёный.
- [ ] `scripts/make-release.sh` собрал `dist/` без ошибок.

## 3. Git-история

В ранних коммитах есть внутренние документы и LAN-адреса. Для публичного GitHub рекомендуется
публиковать **чистую историю** (один коммит либо `git filter-repo` для удаления `docs/internal/`),
а не пушить текущую. Решение о переписывании истории принимает maintainer.

```sh
# вариант «чистый старт»: отдельная ветка с текущим деревом и одним коммитом
git checkout --orphan public-release
git add -A
git commit -m "pulsar-brain v0.1.0"
```

## 4. GitHub

```sh
git remote add github git@github.com:Thedamem/pulsar-brain.git
git push -u github main
```

Затем в настройках репозитория: description и topics (`home-assistant`, `hacs`, `voice-assistant`,
`yandex-station`, `esphome`, `mcp`). Для HACS понадобится релиз:

```sh
scripts/make-release.sh
git tag -a v0.1.0 -m "pulsar-brain v0.1.0"
git push github v0.1.0
gh release create v0.1.0 dist/pulsar_brain.zip dist/SHA256SUMS --title "v0.1.0" --notes-file docs/status.md
```

После релиза добавить в HACS: **Custom repositories** → URL → category **Integration**.

## 5. Forgejo (аддон-стор)

```sh
FORGEJO_URL=https://git.example.com FORGEJO_TOKEN=<token> scripts/publish-local.sh
```

В HA: **Настройки → Аддоны → Магазин → ⋮ → Репозитории** → URL репозитория. Supervisor соберёт
образ из `addon/Dockerfile`; нужна сеть и архитектура `aarch64`/`amd64`.

## 6. Обновление версии

1. Поднять версию в `custom_components/pulsar_brain/manifest.json` и `addon/config.yaml`.
2. `scripts/make-release.sh`, тег `v<version>`, релиз с теми же ассетами.
3. Supervisor видит новую версию аддона по `config.yaml`; HACS — по тегу релиза.

## 7. Что не публиковать

- `dev/data/`, `dev/ha-config/.storage/`, `dev/ha-token.txt`, `dev/forgejo-token.txt`, `.env`;
- `docs/internal/` (внутренние ревью и аудит безопасности);
- `dist/`, `node_modules`, `__pycache__`, логи.
