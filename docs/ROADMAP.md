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
- первая платформа подтверждена как macOS Apple Silicon.

## Phase 1: оболочка приложения

Цель: создать базовое Tauri-приложение.

Результаты:

- Tauri v2 app;
- React + TypeScript frontend;
- package manager и workspace structure;
- linting/formatting;
- basic CI;
- окно приложения с placeholder status screen;
- команды для локальной разработки.

Критерии завершения:

- приложение запускается локально на macOS Apple Silicon;
- CI проходит TypeScript checks и basic build.

## Phase 2: Core TypeScript логика

Цель: собрать OS-independent продуктовую логику.

Результаты:

- API client;
- shared API types;
- local cache;
- route list validator;
- route diff engine;
- state machine для connect/sync/error states;
- mock backend для локальной разработки.

Критерии завершения:

- приложение умеет получать и кешировать route list из mock API;
- изменения маршрутов дают deterministic add/remove operations;
- unit tests покрывают core route logic.

## Phase 3: macOS Tunnel Control MVP

Цель: сделать приложение реально полезным на macOS.

Результаты:

- macOS native adapter skeleton;
- secure storage через Keychain;
- tunnel profile connect/disconnect;
- status detection;
- basic route apply/remove;
- admin permission flow там, где нужны повышенные права.

Критерии завершения:

- пользователь может подключаться и отключаться из приложения;
- приложение умеет определять active tunnel interface;
- protected routes применяются при подключении.

## Phase 4: Watchdog и Fail-Closed

Цель: защитить маршрутизацию при реальных сбоях.

Результаты:

- route drift watchdog;
- route repair;
- fail-closed policy;
- recovery after sleep/wake;
- recovery after network changes;
- diagnostics panel;
- redacted log export.

Критерии завершения:

- route drift чинится автоматически;
- protected destinations не утекают при падении tunnel;
- приложение восстанавливается после sleep/wake без ручной чистки маршрутов.

## Phase 5: Packaging и Distribution для macOS

Цель: подготовить тестируемый macOS build.

Результаты:

- Apple Silicon build artifact;
- DMG packaging;
- app icon;
- versioning;
- updater decision;
- signing/notarization plan;
- install/uninstall cleanup checks.

Критерии завершения:

- tester может установить приложение из DMG;
- приложение запускается после перезагрузки, если включен autostart;
- uninstall удаляет helper/routes/config без сломанной сети.

## Phase 6: усиление Backend API

Цель: сделать control plane безопасным для реальных пользователей.

Результаты:

- client auth endpoints;
- route list versioning;
- route list hash/signature;
- subscription enforcement;
- app version policy;
- event ingestion;
- изменения admin dashboard, если понадобятся.

Критерии завершения:

- expired users не получают usable route updates;
- revoked devices перестают работать после token revocation;
- изменения route list доходят до клиентов в рамках sync interval.

## Phase 7: Windows Adapter

Цель: добавить Windows desktop support.

Результаты:

- Windows native adapter;
- secure storage;
- profile setup;
- route sync;
- fail-closed implementation;
- Windows installer;
- Windows CI/build job.

Критерии завершения:

- пользователи Windows 10/11 могут установить приложение, подключиться, синхронизировать маршруты и отключиться;
- fail-closed behavior проходит manual tests.

## Phase 8: Android Technical Spike

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

## Phase 9: Android MVP

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
