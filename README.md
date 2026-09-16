# Tunnel Manager Client macOS

macOS-форк клиента на базе [`danifest751/magnetgate`](https://github.com/danifest751/magnetgate).
Цель этого репозитория прежняя: отдельное desktop-приложение для пользователей Tunnel Manager,
которое не ломает существующий серверный контур и в первом MVP ориентируется на macOS Apple Silicon.

## Что уже импортировано

- core `magnetgate`: rendezvous через DHT/Nostr, native fallback и SOCKS-клиент;
- Electron desktop UI из `magnetgate/app`;
- macOS-ветка запуска `sing-box` TUN без Windows PowerShell/Wintun;
- сборка Electron по умолчанию в macOS `dmg`/`zip`;
- pinned-установка `sing-box` для macOS `arm64` и `amd64`.

Windows-скрипты upstream оставлены в репозитории как наследие форка, но главный desktop-путь здесь —
macOS. Persistent firewall/kill-switch из Windows-версии на macOS пока отключён: full/split routing
работает через TUN `sing-box`, а отдельный macOS Network Extension/helper ещё нужно проектировать.

## Быстрый старт для разработки

Требуется Node.js >=20.19.0 для core и Node.js 22.12+ для desktop tooling.

```bash
npm ci
bash scripts/get-singbox-macos.sh
cd app
npm ci
npm run install:electron
npm test
npm start
```

Сборка macOS artifact:

```bash
cd app
npm run dist:mac
```

Артефакты появятся в `app/dist/`.

## Документы

- [Техническое задание](docs/TECH_SPEC.md) - детальная редакция с нумерованными требованиями
- [Спецификация Backend API](docs/API_SPEC.md) - контракт `/client/v1/*`
- [Каталог ошибок и правила отчетов](docs/ERROR_CATALOG.md) - категории, fingerprint, redaction, rate limit
- [Дорожная карта](docs/ROADMAP.md)
- [Upstream README](docs/MAGNETGATE_UPSTREAM.md)
- [Upstream README RU](docs/MAGNETGATE_UPSTREAM.ru.md)
