# Tunnel Manager Client: дорожная карта

Принцип: сначала снимаем главный риск, потом строим продукт. Главный риск - native-часть (туннель, маршруты, fail-closed, helper) на двух ОС. Поэтому после фазы решений идет walking skeleton, а не оболочка приложения. TypeScript-ядро делается параллельно: оно ничем не рискует и не должно ждать.

## Phase 0: решения, спецификация, окружение

Цель: согласовать направление и убрать неизвестные, от которых зависит весь native-код.

Результаты:

- public repository, `README.md`, техническое задание, roadmap;
- явное разделение приватного серверного контура и коммерческого клиентского приложения;
- decision records: ADR-001 транспорт, ADR-002 путь на macOS, ADR-003 разрешение доменов;
- подтверждение D1 (транспорт) у существующего серверного Tunnel Manager;
- тестовое окружение по `NFR-047`: тестовая tunnel-точка, staging backend, тестовые коды, стенд leak-тестов, физическая Windows-машина;
- запрошены сертификаты: Apple Developer ID и code signing для Windows;
- стартовый список issues.

Критерии завершения:

- стек утвержден;
- D1-D3 подтверждены или пересмотрены с обновлением ТЗ;
- платформы MVP подтверждены: macOS Apple Silicon и Windows 10/11 x64, обе выходят одним релизом;
- тестовая tunnel-точка и staging backend доступны разработчикам.

## Phase 1: walking skeleton

Цель: доказать на обеих платформах, что native-часть реализуема, до написания UI и backend.

Результаты на каждой платформе, без UI и без backend:

- privileged helper на macOS и служба на Windows с IPC и проверкой вызывающего;
- поднятие WireGuard-туннеля до тестовой точки из helper;
- добавление и удаление одного маршрута через туннель;
- блокировка одного CIDR на физических интерфейсах: pf на macOS, WFP на Windows;
- переживание `kill -9` приложения: блокировка остается, helper снимает ее по таймауту;
- минимальный leak-тест L1, L2, L5 с захватом трафика.

Параллельно и независимо от skeleton - Core TypeScript:

- `route-engine`, `api-client`, `local-store`, `shared-types`;
- state machine для connect/sync/error;
- модель redacted error report;
- mock backend;
- unit tests на route logic, cache, backoff, redaction.

Критерии завершения:

- skeleton проходит L1, L2, L5 на macOS и на Windows;
- ADR-002 подтвержден, либо заменен на NetworkExtension с пересчетом сроков фазы 3;
- core-пакеты покрыты тестами и не содержат ОС-специфичного кода;
- принято решение "идем дальше" или "меняем план".

Ориентир по сроку: 3-4 недели. Если skeleton не проходит за 6 недель, план пересматривается до начала фазы 2, а не после.

## Phase 2: оболочка приложения и интеграция core

Цель: собрать приложение вокруг уже проверенного ядра.

Результаты:

- Tauri v2 app, React + TypeScript frontend;
- package manager и workspace structure, linting/formatting;
- CI с двумя раннерами: macOS и Windows;
- окно приложения с простым пользовательским status screen;
- выключенный по умолчанию placeholder для "Режима эксперта";
- core подключен к UI через status model;
- fake `NativeAdapter` для разработки UI без прав и без туннеля;
- команды для локальной разработки на обеих ОС.

Критерии завершения:

- приложение запускается локально на macOS и на Windows;
- CI проходит TypeScript checks, unit tests и basic build на обоих раннерах;
- route list из mock API получается и кешируется;
- обычный UI не показывает техническую диагностику без режима эксперта.

## Phase 3: Tunnel Control MVP на macOS и Windows

Цель: сделать приложение реально полезным на обеих desktop-платформах.

Обе платформы делаются параллельно против одного контракта `NativeAdapter` из раздела 13.2 ТЗ. Skeleton из фазы 1 оборачивается в адаптеры, а не переписывается.

Общие результаты:

- зафиксированный контракт native adapter;
- connect/disconnect из UI;
- status detection и определение active tunnel interface;
- basic route apply/remove;
- permission flow там, где нужны повышенные права;
- активация устройства против staging backend, генерация ключевой пары на клиенте;
- общий набор интеграционных тестов, который гоняется на обеих ОС.

macOS:

- native adapter поверх helper из фазы 1;
- secure storage через Keychain.

Windows:

- native adapter поверх службы из фазы 1;
- named pipe с ACL и проверкой вызывающего;
- secure storage через Credential Manager или DPAPI;
- сертификат code signing проверен на тестовой сборке.

Критерии завершения:

- на каждой платформе пользователь может подключаться и отключаться из приложения;
- на каждой платформе приложение определяет active tunnel interface;
- protected routes применяются при подключении на обеих платформах;
- расхождения между платформами сведены к таблице 19.4 ТЗ.

## Phase 4: Watchdog и Fail-Closed

Цель: защитить маршрутизацию при реальных сбоях.

Результаты:

- событийный watchdog с контрольной сверкой;
- route repair;
- fail-closed policy полностью: pf на macOS, WFP или firewall на Windows;
- явное управление метриками маршрутов на Windows;
- автоматическая отправка важных ошибок подключения через backend;
- ручная кнопка отправки ошибки админам;
- дедупликация и rate-limit error reports;
- режим эксперта: диагностика и проверка домена (`FR-168`), без локальных правил;
- recovery after sleep/wake;
- recovery after network changes;
- redacted логи.

Критерии завершения:

- route drift чинится автоматически на обеих платформах;
- protected destinations не утекают при падении tunnel: leak-тесты L1-L8 пройдены и на macOS, и на Windows;
- на Windows приложение корректно уживается с включенным Windows Firewall и сторонним VPN-клиентом;
- важные ошибки подключения попадают админам без чувствительных данных;
- пользователь может одной кнопкой отправить ошибку, если она не отправилась автоматически;
- приложение восстанавливается после sleep/wake без ручной чистки маршрутов.

## Phase 5: Packaging, updater и distribution

Цель: подготовить устанавливаемые и обновляемые build для macOS и Windows из одного релизного пайплайна.

Общие результаты:

- сборка обеих платформ из CI по одному тегу с одинаковой версией;
- app icon, versioning;
- встроенный updater с подписанным манифестом обновлений, обязателен для 1.0 (`FR-082`);
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
- обновление с предыдущей версии через updater проходит на обеих платформах с сохранением активации;
- релиз содержит оба артефакта; выпуск с одним артефактом не публикуется.

## Phase 6: Backend API и админка

Цель: сделать control plane безопасным для реальных пользователей и видимым для администратора.

Результаты:

- client auth endpoints, регистрация peer по публичному ключу устройства;
- route list versioning и content hash;
- разрешение доменных списков в IP-наборы на backend (ADR-003);
- subscription enforcement;
- app version policy;
- endpoint для error reports, Telegram-уведомления, дедупликация и rate-limit;
- endpoint диагностики;
- раздел админки по 15.4 ТЗ: устройства, error reports, коды активации;
- выдача кода активации Telegram-ботом после оплаты.

Критерии завершения:

- expired users не получают usable route updates;
- revoked devices перестают работать после token revocation;
- админы получают только важные ошибки подключения, а не поток шумных событий;
- изменения route list доходят до клиентов в рамках sync interval;
- администратор видит список устройств с версиями и возрастом whitelist и страницу отчетов.

## Релиз 1.0: macOS и Windows

Отдельной фазы под Windows нет: Windows-адаптер, установщик и CI-раннер входят в фазы 1-5 наравне с macOS.

Условия выпуска 1.0:

- Definition of Done раздела 2.4 ТЗ выполнен для обеих платформ;
- ручная матрица M1-M15 плюс W1-W6 и D1-D2 пройдена на чистых машинах;
- leak-тесты L1-L8 пройдены на обеих платформах;
- оба артефакта подписаны и собраны из одного тега;
- updater работает на обеих платформах;
- бот выдает коды активации после оплаты.

## Релиз 1.1

Состав по разделу 3.4 ТЗ:

- локальные правила пользователя в режиме эксперта;
- экспорт diagnostic bundle;
- подпись route list Ed25519 и ее проверка на клиенте;
- endpoint событий;
- DNS для защищенных доменов через туннель (OQ-8);
- несколько tunnel-точек с приоритетом;
- английская локаль;
- Windows on ARM.

## Phase 7: Android Technical Spike

Может идти параллельно фазам 5 и 6: не пересекается с desktop-кодом. С WireGuard путь на Android известен - системный tunnel service плюс штатная библиотека, поэтому spike скорее подтверждает, чем открывает.

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
