# Tunnel Manager Client: спецификация Backend API

Версия документа: 1.0
Относится к: [Техническое задание](TECH_SPEC.md), раздел 15.

Документ описывает контракт между клиентским приложением и control plane. Все примеры используют заглушки вместо реальных адресов, идентификаторов и ключей.

## 1. Общие правила

### 1.1. Базовый адрес и версионирование

- Базовый адрес: `https://<BACKEND_HOST>/client/v1`.
- Namespace `/client/v1` принадлежит только коммерческому клиентскому контуру. Приватный серверный контур, админка и Telegram-бот используют существующие пути и не затрагиваются.
- Ломающие изменения выпускаются как `/client/v2`. В пределах одной версии допустимо только добавление необязательных полей.

### 1.2. Обязательные заголовки клиента

| Заголовок | Пример | Назначение |
| --- | --- | --- |
| `Authorization` | `Bearer <access_token>` | для всех запросов, кроме `activate` |
| `X-Client-Version` | `1.4.2` | версия приложения |
| `X-Client-Platform` | `macos-arm64` | платформа сборки: `macos-arm64`, `windows-x64`, позже `windows-arm64`, `android-arm64` |
| `X-Device-Id` | `dev_9f3a...` | идентификатор устройства |
| `X-Request-Id` | UUID v4 | корреляция запроса в логах |
| `Idempotency-Key` | UUID v4 | для всех `POST` |
| `If-None-Match` | `"w-8421"` | условный запрос для `GET /routes` |

### 1.3. Общие поля ответа

Каждый успешный ответ содержит:

```json
{
  "serverTime": "2026-09-01T12:00:00Z",
  "minSupportedVersion": "1.2.0"
}
```

- `serverTime` - клиент использует для коррекции расхождения часов; локальное время не является авторитетом для проверки доступа.
- `minSupportedVersion` - если версия клиента ниже, клиент переходит в `update_required` и блокирует подключение.

### 1.4. Формат ошибок

```json
{
  "error": {
    "code": "subscription_expired",
    "message": "Подписка истекла",
    "retryable": false,
    "retryAfterSec": null,
    "details": {}
  },
  "serverTime": "2026-09-01T12:00:00Z"
}
```

| HTTP | `code` | Поведение клиента |
| --- | --- | --- |
| 400 | `invalid_request` | не ретраить, отчет в диагностику |
| 401 | `token_expired` | обновить access token и повторить один раз |
| 401 | `token_revoked` | полный выход: отключиться, очистить секреты, экран активации |
| 403 | `device_revoked` | как `token_revoked` |
| 403 | `subscription_expired` | состояние `access_expired` |
| 409 | `activation_conflict` | показать причину на экране активации |
| 412 | `client_too_old` | состояние `update_required` |
| 429 | `rate_limited` | уважать `retryAfterSec` |
| 5xx | `server_error` | ретрай с backoff |

### 1.5. Ограничения

| Параметр | Значение по умолчанию |
| --- | --- |
| Rate limit на устройство | 60 запросов в 10 минут |
| Максимальный размер тела запроса | 256 КБ |
| Таймаут клиента на запрос | 15 с (30 с для `routes`) |
| Сжатие | `gzip` обязательно поддерживается на `GET /routes` |

---

## 2. `POST /client/v1/auth/activate`

Регистрирует устройство и выдает токены. Единственный endpoint без `Authorization`.

Запрос:

```json
{
  "activationCode": "XXXX-XXXX-XXXX",
  "device": {
    "deviceId": "dev_9f3a7c2e5b114d8e",
    "platform": "macos-arm64",
    "osVersion": "14.5",
    "appVersion": "1.4.2",
    "displayName": "MacBook Pro"
  }
}
```

- `deviceId` генерируется клиентом при первой активации: случайные 128 бит в hex. Аппаратные идентификаторы использовать запрещено.
- `displayName` - необязательное человекочитаемое имя для админки, задается пользователем или берется из имени компьютера.

Ответ `200`:

```json
{
  "accessToken": "<jwt>",
  "accessTokenExpiresIn": 900,
  "refreshToken": "<opaque>",
  "refreshTokenExpiresIn": 2592000,
  "device": { "deviceId": "dev_9f3a7c2e5b114d8e", "status": "active" },
  "serverTime": "2026-09-01T12:00:00Z",
  "minSupportedVersion": "1.2.0"
}
```

Ошибки: `invalid_request`, `activation_code_invalid`, `activation_code_used`, `device_limit_reached`, `subscription_expired`, `rate_limited`.

Требования:

- `API-010` (MUST). Код активации одноразовый и имеет ограниченный срок жизни.
- `API-011` (MUST). При превышении лимита устройств backend возвращает `device_limit_reached` и список активных устройств для отображения пользователю (без чувствительных данных).
- `API-012` (MUST). Повторная активация на том же `deviceId` заменяет предыдущую регистрацию и не расходует лимит.

---

## 3. `POST /client/v1/auth/refresh`

Запрос:

```json
{ "refreshToken": "<opaque>", "deviceId": "dev_9f3a7c2e5b114d8e" }
```

Ответ `200`:

```json
{
  "accessToken": "<jwt>",
  "accessTokenExpiresIn": 900,
  "refreshToken": "<новый opaque>",
  "refreshTokenExpiresIn": 2592000,
  "serverTime": "2026-09-01T12:00:00Z",
  "minSupportedVersion": "1.2.0"
}
```

Требования:

- `API-020` (MUST). Refresh token ротируется при каждом использовании, старый немедленно инвалидируется.
- `API-021` (MUST). Повторное использование инвалидированного refresh token трактуется как компрометация: устройство отзывается, клиент получает `token_revoked`.
- `API-022` (MUST). Backend проверяет статус подписки и устройства при каждом refresh - это основной механизм своевременного отзыва доступа.

---

## 4. `GET /client/v1/profile`

Ответ `200`:

```json
{
  "user": { "id": "usr_2c81", "displayName": "Пользователь" },
  "subscription": {
    "status": "active",
    "plan": "standard",
    "expiresAt": "2026-10-01T00:00:00Z",
    "graceUntil": null
  },
  "device": {
    "deviceId": "dev_9f3a7c2e5b114d8e",
    "status": "active",
    "activatedAt": "2026-08-01T10:12:00Z",
    "deviceLimit": 3,
    "devicesUsed": 1
  },
  "policy": {
    "syncIntervalSec": 420,
    "watchdogIntervalSec": 20,
    "failClosedDefault": true,
    "failClosedUserOverride": true,
    "staleGraceMultiplier": 3,
    "hardExpirySec": 604800,
    "maxRoutes": 10000,
    "errorReportRateLimitPerHour": 4
  },
  "serverTime": "2026-09-01T12:00:00Z",
  "minSupportedVersion": "1.2.0"
}
```

`subscription.status`: `active` | `expired` | `suspended`.
`device.status`: `active` | `revoked`.

Требования:

- `API-030` (MUST). Профиль запрашивается при старте приложения, при подключении и не реже одного раза в час.
- `API-031` (MUST). Клиент применяет присланные значения `policy`, но ограничивает их безопасными границами: `syncIntervalSec` в диапазоне 300-600, `watchdogIntervalSec` в диапазоне 15-30.
- `API-032` (MUST). `failClosedUserOverride: false` означает, что пользователь не может выключить fail-closed.

---

## 5. `GET /client/v1/routes`

Запрос: `GET /client/v1/routes` с `If-None-Match: "<etag>"`.

Ответ `304` - список не изменился, тело пустое.

Ответ `200`:

```json
{
  "version": 8421,
  "contentHash": "sha256:3b1f...",
  "signature": {
    "alg": "ed25519",
    "keyId": "rk_2026_01",
    "value": "base64:..."
  },
  "generatedAt": "2026-09-01T11:58:00Z",
  "ttlSec": 900,
  "groupId": "default",
  "resetVersion": false,
  "services": [
    {
      "id": "svc_a",
      "title": "Сервис A",
      "ipv4": ["203.0.113.0/24", "198.51.100.14/32"],
      "ipv6": ["2001:db8:1::/48"]
    },
    {
      "id": "svc_b",
      "title": "Сервис B",
      "ipv4": ["192.0.2.0/24"],
      "ipv6": []
    }
  ],
  "emergencyBlocklist": {
    "ipv4": [],
    "ipv6": []
  },
  "serverTime": "2026-09-01T12:00:00Z",
  "minSupportedVersion": "1.2.0"
}
```

Семантика полей:

| Поле | Смысл |
| --- | --- |
| `version` | монотонно растущая версия списка, основа anti-rollback |
| `contentHash` | SHA-256 канонизированного набора префиксов |
| `signature` | detached-подпись канонизированного представления, `keyId` для ротации ключей |
| `ttlSec` | срок актуальности списка, дальше действует политика grace |
| `groupId` | группа маршрутов; в MVP всегда `default`, заложено под тарифы (OQ-4) |
| `resetVersion` | разрешает принять список с версией ниже текущей |
| `services` | группировка по сервисам, используется в диагностике режима эксперта |
| `emergencyBlocklist` | префиксы, которые нужно исключить из tunnel даже если они есть в `services` |

Требования:

- `API-040` (MUST). Канонизация для хеша и подписи: объединить все `ipv4` и `ipv6`, нормализовать (нижний регистр, обнуление host-битов), отсортировать лексикографически, соединить через `\n`, посчитать SHA-256. Алгоритм фиксируется тестовыми векторами в репозитории.
- `API-041` (MUST). `emergencyBlocklist` применяется последним и имеет приоритет над `services`.
- `API-042` (MUST). Backend отдает `ETag`, равный `"<version>"`, и поддерживает `If-None-Match`.
- `API-043` (MUST). Ответ отдается со сжатием, если клиент прислал `Accept-Encoding: gzip`.
- `API-044` (MUST). Устройству с истекшей подпиской backend возвращает `403 subscription_expired` и не отдает список.

---

## 6. `GET /client/v1/endpoint`

Ответ `200`:

```json
{
  "endpointId": "ep_eu_1",
  "title": "Европа 1",
  "host": "<ENDPOINT_HOST>",
  "port": 51820,
  "protocol": "<TUNNEL_PROTOCOL>",
  "publicKey": "<ENDPOINT_PUBLIC_KEY>",
  "clientConfigRef": "cfg_7f21",
  "keepaliveSec": 25,
  "mtu": 1380,
  "serverTime": "2026-09-01T12:00:00Z",
  "minSupportedVersion": "1.2.0"
}
```

Требования:

- `API-050` (MUST). Endpoint выдается только активному устройству с валидной подпиской.
- `API-051` (MUST). Клиент **MUST** исключить `host` (и его разрешенный IP) из набора tunnel-маршрутов, чтобы не создать петлю.
- `API-052` (MUST). Клиент **MUST NOT** логировать `host`, `publicKey` и `clientConfigRef` в открытом виде; в диагностике используется `endpointId` и хеш.
- `API-053` (SHOULD). Backend **SHOULD** уметь выдавать несколько endpoint с приоритетом, чтобы клиент мог переключиться при недоступности основного. В MVP допускается один.

---

## 7. `POST /client/v1/events`

Запрос:

```json
{
  "events": [
    {
      "type": "connect_started",
      "ts": "2026-09-01T11:59:40Z",
      "appVersion": "1.4.2",
      "data": { "trigger": "user" }
    },
    {
      "type": "route_sync_ok",
      "ts": "2026-09-01T12:00:02Z",
      "appVersion": "1.4.2",
      "data": { "version": 8421, "added": 12, "removed": 3, "total": 486 }
    }
  ]
}
```

Допустимые `type`:

| Тип | Когда |
| --- | --- |
| `app_started` | запуск приложения |
| `connect_started` | начато подключение |
| `connect_ok` | подключение завершено успешно |
| `connect_failed` | подключение не удалось |
| `disconnected` | отключение (с `data.reason`) |
| `route_sync_ok` | синхронизация успешна |
| `route_sync_failed` | синхронизация не удалась |
| `fail_closed_enabled` | fail-closed активирован |
| `fail_closed_disabled` | fail-closed деактивирован |
| `subscription_expired` | клиент узнал об истечении доступа |
| `drift_repaired` | watchdog починил маршруты |

Требования:

- `API-060` (MUST). События **MUST NOT** содержать посещенные URL, payload, историю браузинга и содержимое трафика.
- `API-061` (MUST). Поле `data` ограничено allowlist-ключами: числа, перечислимые строки, булевы значения. Свободный текст запрещен.
- `API-062` (MUST). Клиент отправляет события пачками не чаще одного раза в 60 секунд; очередь в памяти ограничена 200 событиями, при переполнении отбрасываются самые старые информационные.
- `API-063` (MUST). Потеря событий не влияет на работу клиента: endpoint best-effort.

---

## 8. `POST /client/v1/diagnostics`

Принимает агрегированную диагностику, в первую очередь validation errors по route list.

Запрос:

```json
{
  "ts": "2026-09-01T12:00:03Z",
  "appVersion": "1.4.2",
  "platform": "macos-arm64",
  "routeListVersion": 8421,
  "validation": {
    "accepted": 486,
    "rejected": 4,
    "samples": [
      { "value": "10.0.0.0/8", "reason": "private_range_not_allowed" },
      { "value": "203.0.113.0/33", "reason": "invalid_prefix_length" }
    ]
  },
  "counters": {
    "appliedRoutes": 486,
    "localRules": 2,
    "driftRepairs24h": 1,
    "syncFailures24h": 0
  }
}
```

Требования:

- `API-070` (MUST). `samples` ограничены 20 записями и содержат только сами префиксы и причину.
- `API-071` (MUST). Диагностика отправляется не чаще одного раза в час на устройство, а также сразу после отклонения списка целиком.
- `API-072` (SHOULD). Backend **SHOULD** агрегировать validation errors по всем устройствам, чтобы администратор видел проблему в самом route list, а не в отдельном клиенте.

---

## 9. `POST /client/v1/error-reports`

Запрос:

```json
{
  "fingerprint": "a1b2c3d4e5f60718",
  "category": "tunnel_start_failed",
  "severity": "error",
  "stage": "connect.tunnel_start",
  "ts": "2026-09-01T12:00:05Z",
  "occurrences": 1,
  "firstSeenAt": "2026-09-01T12:00:05Z",
  "app": { "version": "1.4.2", "channel": "stable" },
  "platform": { "os": "macos", "osVersion": "14.5", "arch": "arm64" },
  "device": { "deviceId": "dev_9f3a7c2e5b114d8e" },
  "context": {
    "state": "connecting",
    "helperVersion": "1.4.2",
    "endpointId": "ep_eu_1",
    "routeListVersion": 8421,
    "failClosedActive": true,
    "networkType": "wifi",
    "osErrorCode": -60005
  },
  "diagnostics": {
    "message": "helper returned error while starting tunnel profile",
    "lastSteps": ["helper.verify.ok", "tunnel.profile.load.ok", "tunnel.start.failed"]
  },
  "manual": false
}
```

Ответ `200`:

```json
{
  "accepted": true,
  "deduplicated": false,
  "notifiedAdmins": true,
  "serverTime": "2026-09-01T12:00:05Z"
}
```

Требования к backend:

- `API-080` (MUST). Проверить доступ пользователя и устройства до сохранения отчета.
- `API-081` (MUST). Сохранить отчет с сохранением истории повторов.
- `API-082` (MUST). Дедуплицировать по паре (`deviceId`, `fingerprint`) в окне 6 часов; повторы увеличивают счетчик, но не создают новое уведомление.
- `API-083` (MUST). Дедуплицировать по `fingerprint` глобально: если та же ошибка уже пришла от 5 устройств за час, администратору отправляется одно агрегированное сообщение вместо пяти.
- `API-084` (MUST). Применить rate limit: не более 4 отчетов в час на устройство и не более 20 уведомлений в час суммарно в Telegram.
- `API-085` (MUST). Отправлять в Telegram только `severity` = `critical` или `error` и только категории из actionable-списка каталога ошибок.
- `API-086` (MUST). Не отправлять в Telegram шумные события: отключение пользователем, отмена системного prompt, временный сбой сети, восстановленный retry, успешные синхронизации, информационные события.
- `API-087` (MUST). Ответ **MUST** явно сообщать `accepted` и `notifiedAdmins`, чтобы клиент показал пользователю понятный статус.
- `API-088` (MUST). Отчет, помеченный `manual: true`, **MUST** обходить клиентский rate limit и **SHOULD** обходить дедупликацию уведомления, потому что это осознанное действие пользователя.

Формат сообщения администратору в Telegram:

```text
[ERROR] tunnel_start_failed
Устройство: dev_9f3a…4d8e (usr_2c81)
Платформа: macos 14.5 arm64, приложение 1.4.2
Стадия: connect.tunnel_start
Fingerprint: a1b2c3d4e5f60718
Повторов за 6 ч: 1 · Устройств с этой ошибкой за 1 ч: 1
Детали: админка -> Error reports -> a1b2c3d4e5f60718
```

- `API-089` (MUST). Сообщение **MUST NOT** содержать секреты, полный адрес endpoint, tunnel credentials и любые данные о трафике пользователя.

---

## 10. Контрактные требования к совместимости

- `API-090` (MUST). Добавление полей в ответы допустимо; клиент игнорирует неизвестные поля.
- `API-091` (MUST). Удаление или переименование полей - ломающее изменение, требует новой версии namespace.
- `API-092` (MUST). Для каждого endpoint в репозитории поддерживается JSON-схема и набор фикстур, используемых mock-backend и контрактными тестами.
- `API-093` (MUST). Контрактные тесты **MUST** проверять, что изменения `/client/v1/*` не затрагивают существующие пути приватного серверного контура.
