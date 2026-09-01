# Tunnel Manager Client: дорожная карта

## Phase 0: спецификация и настройка репозитория

Цель: подготовить репозиторий и согласовать продуктовое/техническое направление.

Результаты:

- public repository;
- `README.md`;
- техническое задание;
- roadmap;
- явное разделение приватного серверного контура и коммерческого клиентского приложения;
- стартовый список issues после утверждения спецификации;
- decision record по выбранному стеку.

Критерии завершения:

- стек утвержден;
- MVP scope утвержден;
- платформы MVP подтверждены: macOS Apple Silicon и Windows 10/11 x64, обе выходят одним релизом.

## Phase 1: оболочка приложения

Цель: создать базовое Tauri-приложение.

Результаты:

- Tauri v2 app;
- React + TypeScript frontend;
- package manager и workspace structure;
- linting/formatting;
- CI с двумя раннерами: macOS и Windows;
- окно приложения с простым пользовательским status screen;
- выключенный по умолчанию placeholder для "Режима эксперта";
- команды для локальной разработки на обеих ОС.

Критерии завершения:

- приложение запускается локально на macOS Apple Silicon и на Windows 10/11;
- CI проходит TypeScript checks и basic build на обоих раннерах.

## Phase 2: Core TypeScript логика

Цель: собрать OS-independent продуктовую логику.

Результаты:

- API client;
- shared API types;
- local cache;
- route list validator;
- route diff engine;
- state machine для connect/sync/error states;
- модель пользовательских и экспертных состояний UI;
- модель redacted error report;
- mock backend для локальной разработки.

Критерии завершения:

- приложение умеет получать и кешировать route list из mock API;
- изменения маршрутов дают deterministic add/remove operations;
- обычный UI не показывает техническую диагностику без режима эксперта;
- unit tests покрывают core route logic.

## Phase 3: Tunnel Control MVP на macOS и Windows

Цель: сделать приложение реально полезным на обеих desktop-платформах.

Обе платформы делаются параллельно против одного контракта `NativeAdapter` из раздела 13.2 ТЗ. Первым делается сам контракт и fake-адаптер, чтобы платформенные команды не блокировали друг друга.

Общие результаты:

- зафиксированный контракт native adapter и fake-адаптер для тестов;
- tunnel profile connect/disconnect;
- status detection и определение active tunnel interface;
- basic route apply/remove;
- permission flow там, где нужны повышенные права;
- общий набор интеграционных тестов, который гоняется на обеих ОС.

macOS:

- native adapter;
- privileged helper;
- secure storage через Keychain.

Windows:

- native adapter;
- helper в виде Windows-службы, named pipe с ACL и проверкой вызывающего;
- secure storage через Credential Manager или DPAPI;
- сертификат code signing получен и проверен на тестовой сборке.

Критерии завершения:

- на каждой платформе пользователь может подключаться и отключаться из приложения;
- на каждой платформе приложение определяет active tunnel interface;
- protected routes применяются при подключении на обеих платформах;
- расхождения между платформами сведены к таблице 19.4 ТЗ.

## Phase 4: Watchdog и Fail-Closed

Цель: защитить маршрутизацию при реальных сбоях.

Результаты:

- route drift watchdog;
- route repair;
- fail-closed policy: packet filter на macOS, WFP или firewall на Windows;
- явное управление метриками маршрутов на Windows;
- автоматическая отправка важных ошибок подключения через backend;
- ручная кнопка отправки ошибки админам;
- дедупликация и rate-limit error reports;
- режим эксперта с локальными пользовательскими правилами whitelist;
- recovery after sleep/wake;
- recovery after network changes;
- diagnostics panel;
- redacted log export.

Критерии завершения:

- route drift чинится автоматически на обеих платформах;
- protected destinations не утекают при падении tunnel: leak-тесты L1-L8 пройдены и на macOS, и на Windows;
- на Windows приложение корректно уживается с включенным Windows Firewall и сторонним VPN-клиентом;
- важные ошибки подключения попадают админам без чувствительных данных;
- пользователь может одной кнопкой отправить ошибку, если она не отправилась автоматически;
- локальные пользовательские whitelist-правила применяются только на устройстве пользователя;
- приложение восстанавливается после sleep/wake без ручной чистки маршрутов.

## Phase 5: Packaging и Distribution

Цель: подготовить тестируемые build для macOS и Windows из одного релизного пайплайна.

Общие результаты:

- сборка обеих платформ из CI по одному тегу с одинаковой версией;
- app icon;
- versioning;
- решение по updater, единое для обеих платформ;
- install/uninstall cleanup checks.

macOS:

- Apple Silicon build artifact;
- DMG packaging;
- signing и notarization.

Windows:

- x64 build artifact;
- установщик MSI или NSIS;
- подпись установщика и исполняемых файлов, проверка прохождения SmartScreen;
- корректная установка и удаление службы helper.

Критерии завершения:

- tester может установить приложение из DMG на macOS и из установщика на Windows;
- приложение запускается после перезагрузки на обеих платформах, если включен autostart;
- uninstall удаляет helper/службу, routes и config без сломанной сети на обеих платформах;
- релиз содержит оба артефакта; выпуск с одним артефактом не публикуется.

## Phase 6: усиление Backend API

Цель: сделать control plane безопасным для реальных пользователей.

Результаты:

- client auth endpoints;
- route list versioning;
- route list hash/signature;
- subscription enforcement;
- app version policy;
- event ingestion;
- endpoint для error reports;
- Telegram-уведомления администраторам по важным ошибкам;
- дедупликация и rate-limit уведомлений;
- изменения admin dashboard, если понадобятся.

Критерии завершения:

- expired users не получают usable route updates;
- revoked devices перестают работать после token revocation;
- админы получают только важные ошибки подключения, а не поток шумных событий;
- изменения route list доходят до клиентов в рамках sync interval.

## Релиз 1.0: macOS и Windows

Отдельной фазы под Windows нет: Windows-адаптер, установщик и CI-раннер входят в фазы 1, 3, 4 и 5 наравне с macOS.

Условия выпуска 1.0:

- Definition of Done раздела 2.4 ТЗ выполнен для обеих платформ;
- ручная матрица M1-M15 плюс W1-W6 и D1-D2 пройдена на чистых машинах;
- leak-тесты L1-L8 пройдены на обеих платформах;
- оба артефакта подписаны и собраны из одного тега.

## Phase 7: Android Technical Spike

Цель: проверить Android-архитектуру до полноценной разработки.

Результаты:

- Android Tauri shell evaluation;
- system tunnel service prototype;
- background sync prototype;
- always-on behavior analysis;
- Google Play policy checklist;
- decision record.

Критерии завершения:

- принято понятное go/no-go решение по Android implementation path;
- известные риски и required native work задокументированы.

## Phase 8: Android MVP

Цель: выпустить первый Android test build, если spike успешен.

Результаты:

- Android app build;
- tunnel service;
- route policy sync;
- local cache;
- connection status;
- fail-closed equivalent там, где поддерживается;
- internal testing build.

Критерии завершения:

- Android user может установить приложение, подключиться и получать route updates;
- поведение приложения приемлемое при network changes и reboot.
