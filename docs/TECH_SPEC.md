# Tunnel Manager Client: техническое задание

## 1. Краткое описание

Tunnel Manager Client - desktop/mobile-приложение, которое устанавливается на устройство пользователя и локально управляет защищенной split-routing логикой. Backend остается ответственным за пользователей, подписки, списки маршрутов, metadata tunnel-точек и аналитику. Клиент отвечает за подключение устройства, синхронизацию whitelist, применение локальных маршрутов и защиту от утечки защищенного трафика через обычную сеть при недоступности tunnel.

Первый релиз делаем под macOS на Apple Silicon. Поддержку Windows и Android нужно заложить в архитектуру сразу, но не выпускать в первом MVP.

## 2. Цели

- Убрать необходимость в региональном relay/gateway-сервере.
- Оставить только зарубежные tunnel-точки и легкий backend/control plane.
- Перенести синхронизацию и применение маршрутов на устройство каждого пользователя.
- Оставить большую часть кода приложения на TypeScript.
- По возможности переиспользовать поведение текущего Tunnel Manager.
- Сделать продукт простым для пользователя: установить, войти, подключиться и забыть.

## 3. Что не входит в MVP

- Прямое подключение клиента к базе данных.
- Анализ содержимого трафика.
- Enterprise MDM-деплой в первом релизе.
- Linux-клиент в первом релизе.
- Полноценный Android-релиз до отдельного technical spike.
- Публикация инфраструктурных секретов, адресов серверов, private keys, tokens или admin-only endpoints.

## 4. Продуктовые требования

### 4.1 Пользовательский сценарий

1. Пользователь устанавливает Tunnel Manager Client.
2. Пользователь входит в аккаунт или активирует устройство через выданный account/token.
3. Клиент получает из backend API данные подписки и tunnel-точки.
4. Пользователь нажимает "Подключить".
5. Клиент запускает системное tunnel-подключение.
6. Клиент скачивает и применяет актуальный whitelist.
7. Клиент синхронизирует маршруты в фоне.
8. Пользователь может вручную отключиться.
9. Если доступ истек, клиент отключается и удаляет защищенные маршруты.

### 4.2 Главный экран

Главный экран должен показывать:

- состояние подключения;
- состояние аккаунта/подписки;
- оставшееся время доступа;
- время последней успешной синхронизации маршрутов;
- количество активных защищенных маршрутов;
- текущую версию приложения;
- короткую понятную ошибку, если что-то не работает.

### 4.3 Фоновая работа

Приложение должно:

- синхронизировать whitelist каждые 5-10 минут;
- хранить локальный кеш последнего валидного whitelist;
- запускать watchdog для проверки drift маршрутов;
- автоматически восстанавливать отсутствующие маршруты;
- удалять устаревшие маршруты после обновления списка;
- переживать sleep/wake, смену сети и reconnect tunnel-точки;
- запускаться после перезагрузки ОС, если пользователь включил autostart.

### 4.4 Fail-Closed поведение

Если tunnel недоступен, защищенные направления не должны уходить через обычную сеть. Реализация зависит от платформы:

- macOS: route/firewall rules через privileged helper или system network extension.
- Windows: route table плюс Windows filtering/firewall rules, если одних маршрутов недостаточно.
- Android: правила внутри системного Android tunnel service.

Fail-closed должен настраиваться политикой, но по умолчанию быть включенным.

### 4.5 Локальный кеш

Клиент хранит:

- последний валидный whitelist;
- версию/hash whitelist;
- timestamp последней синхронизации;
- user/session metadata;
- несекретные настройки приложения.

Секреты нужно хранить в защищенном хранилище ОС:

- macOS Keychain;
- Windows Credential Manager или DPAPI;
- Android Keystore.

### 4.6 Диагностика

Клиент должен показывать:

- статус подключения;
- текущий tunnel-интерфейс;
- количество маршрутов;
- последнюю ошибку синхронизации;
- доступность backend;
- доступность tunnel endpoint;
- экспортируемый diagnostic bundle с логами и redacted config.

Экспорт диагностики должен скрывать секреты.

## 5. Требования к Backend API

Клиент работает только через backend API, не через базу данных.

Нужные endpoints:

- `POST /client/v1/auth/activate`
- `POST /client/v1/auth/refresh`
- `GET /client/v1/profile`
- `GET /client/v1/routes`
- `GET /client/v1/endpoint`
- `POST /client/v1/events`
- `POST /client/v1/diagnostics`

### 5.1 Ответ со списком маршрутов

Route list должен включать:

- версию списка;
- content hash;
- время генерации;
- TTL;
- группировку по сервисам;
- IPv4 CIDR;
- IPv6 CIDR, когда платформа поддерживается;
- опциональный emergency blocklist;
- минимальную поддерживаемую версию приложения.

Клиент должен игнорировать невалидные CIDR и отправлять validation errors в диагностику.

### 5.2 Events

Клиент должен отправлять легкие события:

- приложение запущено;
- подключение начато/остановлено;
- синхронизация маршрутов успешна/ошибка;
- fail-closed активирован/деактивирован;
- подписка истекла;
- версия приложения.

Events не должны содержать посещенные URL, payload, историю браузинга или содержимое трафика.

## 6. Архитектура

Рекомендуемая структура monorepo:

```text
apps/
  desktop/
    src/
    src-tauri/
packages/
  core/
  api-client/
  route-engine/
  local-store/
  shared-types/
native/
  macos-helper/
  windows-helper/
  android/
docs/
```

### 6.1 TypeScript Core

TypeScript core отвечает за:

- API client;
- валидацию route list;
- route diffing;
- state machine приложения;
- retry/backoff policies;
- формат локального кеша;
- diagnostic model;
- status model для UI.

### 6.2 Native Layer

Native layer отвечает за:

- запуск/остановку системного tunnel profile;
- чтение активных сетевых интерфейсов;
- применение/удаление маршрутов;
- применение fail-closed правил;
- защищенное хранение секретов;
- OS-specific autostart integration.

Native layer должен отдавать в TypeScript-приложение небольшой command API.

### 6.3 Предлагаемый Command API

```ts
type TunnelStatus = {
  state: "disconnected" | "connecting" | "connected" | "degraded" | "error";
  interfaceName?: string;
  endpointReachable: boolean;
  activeRouteCount: number;
  lastError?: string;
};

type NativeAdapter = {
  getStatus(): Promise<TunnelStatus>;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  applyRoutes(routes: string[]): Promise<void>;
  removeRoutes(routes: string[]): Promise<void>;
  enableFailClosed(routes: string[]): Promise<void>;
  disableFailClosed(): Promise<void>;
};
```

## 7. Платформенные заметки

### 7.1 macOS Apple Silicon

macOS MVP стоит начинать с наименее рискованной реализации:

- Tauri desktop app;
- helper process для privileged route operations;
- управление OS tunnel profile;
- Keychain для секретов;
- LaunchAgent/LaunchDaemon для фоновой работы, если понадобится.

Открытый вопрос реализации:

- сначала использовать существующий OS tunnel profile flow;
- или перейти на NetworkExtension, если управление профилем окажется слишком ограниченным.

### 7.2 Windows

Windows support должен использовать:

- native desktop app build через Tauri;
- PowerShell/VPN client APIs для настройки профиля и маршрутов, где это надежно;
- Windows Filtering Platform или firewall rules для fail-closed, если маршрутов недостаточно;
- Credential Manager/DPAPI для секретов;
- scheduled task или service для фоновой работы.

### 7.3 Android

Android требует отдельного technical spike. Скорее всего, нужно использовать системную модель Android tunnel service; относиться к Android как к desktop route management нельзя.

Ключевые вопросы:

- реализовывать ли tunnel полностью внутри приложения;
- встраивать ли существующую tunnel-библиотеку;
- как сохранить единый UX с desktop;
- как поддержать always-on behavior.

## 8. Требования безопасности

- Клиенты не подключаются к базе данных напрямую.
- Production secrets не хардкодятся.
- API access tokens должны быть отзывными.
- Route lists должны быть подписаны или hash-validated.
- Backend должен проверять subscription/access state.
- Клиент должен учитывать minimum API compatibility.
- Логи должны скрывать secrets и endpoint credentials.
- Public repository не должен содержать production infrastructure details.

## 9. Требования к тестированию

### 9.1 Unit tests

- route validation;
- route aggregation;
- route diffing;
- cache expiration;
- retry/backoff behavior;
- subscription state transitions.

### 9.2 Integration tests

- mock backend API;
- route sync при изменении списков;
- offline startup из local cache;
- expired subscription;
- обработка invalid route list.

### 9.3 Manual platform tests

macOS MVP:

- clean install;
- connect/disconnect;
- sleep/wake;
- network change;
- backend unavailable;
- tunnel endpoint unavailable;
- route drift repair;
- fail-closed behavior;
- uninstall cleanup.

## 10. Открытые вопросы

- Точная модель активации пользователя: email link, device code, Telegram approval или admin-issued invite.
- Конкретный tunnel transport для первого релиза.
- Может ли один пользователь активировать несколько устройств.
- Отличаются ли route lists по тарифу/user/group.
- Нужен ли traffic accounting на стороне клиента.
- Модель распространения: direct DMG download, signed/notarized app или store distribution.
