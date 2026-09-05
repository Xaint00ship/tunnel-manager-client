# Tunnel Manager Client: спецификация Backend API

Версия документа: 1.0
Относится к: [Техническое задание](TECH_SPEC.md), раздел 15.

Документ описывает контракт между клиентским приложением и control plane. Все примеры используют заглушки вместо реальных адресов, идентификаторов и ключей.

## 1. Общие правила

### 1.1. Базовый адрес и версионирование

- Базовый адрес: `https://<VPN_SERVER_HOST>/client/v1` - тот же зарубежный сервер, где работает WireGuard (ADR-004). Клиент больше ни с одним хостом не общается.
- Namespace `/client/v1` принадлежит только коммерческому клиентскому контуру. Приватный серверный контур, админка и Telegram-бот используют существующие пути и не затрагиваются.
- Ломающие изменения выпускаются как `/client/v2`. В пределах одной версии допустимо только добавление необязательных полей.
- Реализуется отдельным сервисом `client-api` на зарубежном сервере: FastAPI и Postgres, как у дашборда, но своя БД: устройства, коды активации, публичные ключи, адреса в туннеле, копия статусов подписок. Состояние устройств хранится в БД, а не в файлах, как сейчас WireGuard-конфиги бота. Дашборд и бот интегрируются через admin API (раздел 11).

### 1.2. Обязательные заголовки клиента

| Заголовок | Пример | Назначение |
| --- | --- | --- |
| `Authorization` | `Bearer <access_token>` | для всех запросов, кроме `auth/device-code`, `auth/device-token` и `auth/activate` |
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

## 2. Активация устройства

Единственный интерфейс авторизации для человека - существующий Telegram-бот (ТЗ 5.0). Три endpoint ниже работают без `Authorization`.

### 2.1. `POST /client/v1/auth/device-code`

Приложение запрашивает код связки для сценария deep link.

Запрос:

```json
{
  "device": {
    "deviceId": "dev_9f3a7c2e5b114d8e",
    "platform": "windows-x64",
    "osVersion": "10.0.19045",
    "appVersion": "1.0.0",
    "displayName": "DESKTOP-1"
  },
  "wireguardPublicKey": "<base64, 32 байта>",
  "intent": "login"
}
```

Ответ `200`:

```json
{
  "deviceCode": "<opaque, 32 байта>",
  "userCode": "K7F4-Q2ZP",
  "verificationUrl": "https://t.me/<BOT_NAME>?start=link_K7F4Q2ZP",
  "expiresIn": 600,
  "intervalSec": 3
}
```

- `deviceCode` знает только приложение; `userCode` уходит в бота по ссылке или вводится в боте вручную.
- `intent`: `login` или `trial`. При `trial` бот сразу ведет нового пользователя по онбордингу с пробной подпиской на `trialDays` из настроек (`FR-270`, `FR-271`); для существующего пользователя `trial` равносилен `login`.
- `API-015` (MUST). Код связки одноразовый, живет 10 минут, привязан к `deviceId` и публичному ключу из запроса.

### 2.2. `POST /client/v1/auth/device-token`

Опрос статуса подтверждения.

Запрос: `{ "deviceCode": "<opaque>" }`.

| HTTP | `code` | Значение |
| --- | --- | --- |
| 200 | - | тело как у `activate`: токены и устройство |
| 428 | `authorization_pending` | бот еще не подтвердил, опрашивать дальше |
| 429 | `slow_down` | опрос чаще `intervalSec` |
| 410 | `device_code_expired` | запросить новый код |
| 403 | `subscription_expired`, `device_limit_reached`, `user_not_found` | бот отказал; текст для пользователя в `message` |

- `API-016` (MUST). Подтверждение делает бот вызовом `POST /admin/v1/device-codes/{userCode}/approve` с `userId` и `role` (`user` или `admin` по списку администраторов бота), раздел 11; `client-api` в этот момент регистрирует peer WireGuard, выдает EAP-учетку IKEv2 и отдает токены при следующем опросе.
- `API-017` (MUST). Пользователь, которого бот не знает, получает в боте обычный онбординг; код связки остается в ожидании до истечения, приложение показывает «дождитесь подтверждения».

### 2.3. `POST /client/v1/auth/activate`

Запасной сценарий: код, выданный ботом или админкой, вводится в приложении.

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
  },
  "wireguardPublicKey": "<base64, 32 байта>"
}
```

- `deviceId` генерируется клиентом при первой активации: случайные 128 бит в hex. Аппаратные идентификаторы использовать запрещено.
- `displayName` - необязательное человекочитаемое имя для админки, задается пользователем или берется из имени компьютера.
- `wireguardPublicKey` - публичный ключ пары, сгенерированной на клиенте (ADR-001). Приватный ключ остается в OS keystore устройства и на backend не передается никогда.

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
- `API-013` (MUST). Backend регистрирует `wireguardPublicKey` как peer на tunnel-точке, назначает устройству адреса внутри туннеля и отзывает peer при отзыве устройства. Смена ключа возможна только через повторную активацию.
- `API-014` (MUST). Коды активации выдаются двумя источниками, Telegram-ботом по кнопке «Активировать приложение» и админкой из карточки пользователя, в одном формате и с одним сроком жизни (`FR-008`). Оба источника вызывают `POST /admin/v1/activation-codes`.

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
  "user": { "id": "usr_2c81", "displayName": "Пользователь", "role": "user" },
  "subscription": {
    "status": "active",
    "plan": "standard",
    "isTrial": false,
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
    "watchdogIntervalSec": 60,
    "failClosedDefault": true,
    "failClosedUserOverride": true,
    "staleGraceMultiplier": 3,
    "hardExpirySec": 2592000,
    "maxRoutes": 10000,
    "errorReportRateLimitPerHour": 4,
    "transports": ["wireguard", "ikev2"],
    "transportTimeoutSec": 15
  },
  "serverTime": "2026-09-01T12:00:00Z",
  "minSupportedVersion": "1.2.0"
}
```

`subscription.status`: `active` | `expired` | `suspended`.
`device.status`: `active` | `revoked`.
`user.role`: `user` | `admin` (`FR-280`). В пробном периоде `plan: "trial"` и `isTrial: true`.
`policy.transports`: порядок транспортов (`FR-260`); клиент игнорирует неизвестные значения. `policy.transportTimeoutSec` ограничивается клиентом диапазоном 10-30.

Требования:

- `API-030` (MUST). Профиль запрашивается при старте приложения, при подключении и не реже одного раза в час.
- `API-031` (MUST). Клиент применяет присланные значения `policy`, но ограничивает их безопасными границами: `syncIntervalSec` в диапазоне 300-600, `watchdogIntervalSec` в диапазоне 30-120 (это интервал контрольной сверки, основной механизм watchdog - события ОС, `FR-050`), `hardExpirySec` не меньше 7 суток.
- `API-033` (MUST). Истечение `hardExpirySec` влияет только на новое подключение; работающее подключение backend не может разорвать через эту политику (`FR-162`). Для разрыва используется отзыв устройства или истечение подписки.
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
- `API-045` (MUST). `ipv4` и `ipv6` сервисов backend берет из таблиц `groups` и `ips` дашборда как есть, только агрегируя префиксы (ADR-003, `FR-165`). Резолва доменов нет ни на backend, ни на клиенте; клиент домены не получает.
- `API-046` (MUST). Поле `signature` присутствует в ответе с 1.0, чтобы клиент 1.1 мог начать проверку без изменения контракта; клиент 1.0 его игнорирует (`FR-155`).
- `API-047` (MUST). `services` - проекция таблиц `groups` и `ips` дашборда: `id` = id группы, `title` = имя группы, `ipv4` и `ipv6` = записи группы, агрегированные `collapse_addresses`. Текстовый `GET /api/routes` для приватного контура не меняется; оба представления читают одну таблицу.

---

## 6. `GET /client/v1/endpoint`

Ответ `200`:

```json
{
  "endpointId": "ep_eu_1",
  "title": "Европа 1",
  "host": "<ENDPOINT_HOST>",
  "priority": 1,
  "dnsResolver": "<TUNNEL_RESOLVER_IP>",
  "transports": [
    {
      "type": "wireguard",
      "port": 51820,
      "serverPublicKey": "<ENDPOINT_PUBLIC_KEY>",
      "assignedAddresses": ["<TUNNEL_IPV4>/32", "<TUNNEL_IPV6>/128"],
      "keepaliveSec": 25,
      "mtu": 1380
    },
    {
      "type": "ikev2",
      "remoteId": "<ENDPOINT_HOST>",
      "identity": "dev_9f3a7c2e5b114d8e",
      "password": "<EAP_PASSWORD, только в первом ответе после активации>",
      "caCertPem": null
    }
  ],
  "serverTime": "2026-09-01T12:00:00Z",
  "minSupportedVersion": "1.2.0"
}
```

Требования:

- `API-050` (MUST). Endpoint выдается только активному устройству с валидной подпиской.
- `API-051` (MUST). Клиент **MUST** исключить `host` (и его разрешенный IP) из набора tunnel-маршрутов, чтобы не создать петлю.
- `API-052` (MUST). Клиент **MUST NOT** логировать `host`, `serverPublicKey`, `assignedAddresses`, `identity` и `password` в открытом виде; в диагностике используется `endpointId` и хеш.
- `API-058` (MUST). Пароль IKEv2 выдается один раз: в первом ответе после активации и после явной ротации по `POST /client/v1/endpoint/rotate-ikev2`. В остальных ответах `password: null`; клиент хранит его в OS keystore (`FR-263`).
- `API-059` (MUST). `caCertPem` заполняется только если сервер использует собственный CA (OQ-10); при публично доверенном сертификате поле `null`, и клиент ничего не устанавливает в системное хранилище.
- `API-053` (MUST, 1.1). Backend отдает несколько endpoint с `priority`, клиент переключается на следующий при недоступности основного. В 1.0 всегда один endpoint, поле `priority` уже есть.
- `API-054` (MUST). `assignedAddresses` выдаются per device и привязаны к `wireguardPublicKey` устройства; при повторной активации адреса могут смениться.
- `API-055` (MUST). `AllowedIPs` peer на клиенте не приходят из этого ответа: они равны актуальному route list (`GET /client/v1/routes`) плюс локальные правила. Endpoint описывает только "куда подключаться", а не "что маршрутизировать". Это отличие от сегодняшних `.conf` бота, где `AllowedIPs = 0.0.0.0/0`.
- `API-056` (MUST). `dnsResolver` - адрес резолвера на tunnel-точке, тот же dnsmasq на tunnel-адресе, что сегодня на сервере. Клиент использует его с 1.0 по `FR-167`; адрес **MUST** лежать внутри tunnel-подсети, чтобы быть достижимым только через туннель (`FR-167a`).
- `API-057` (MUST). Peer для устройства регистрируется локально на `wg0` в момент активации (ТЗ 15.5); ответ `GET /client/v1/endpoint` **MUST** отдаваться только после успешной регистрации, иначе клиент получит адрес, к которому не сможет подключиться.

---

## 7. `POST /client/v1/events` (релиз 1.1)

Endpoint относится к релизу 1.1 (ТЗ, раздел 3.4). В 1.0 backend видит устройство по запросам `profile` и `routes`, этого достаточно для списка устройств в админке (`API-005`). Контракт зафиксирован сейчас, чтобы клиент 1.1 не менял схему.

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
    "message": "helper returned error while creating tunnel interface",
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

---

## 11. Admin API: интеграция с дашбордом и ботом

Admin API `client-api` имеет двух потребителей: RU-контур (бот и веб-админка дашборда) по сервисному токену и приложение под пользовательским токеном с ролью `admin` (`FR-280`). Обычный пользователь этот API не видит: без роли любой вызов отвечает `403` и пишется в аудит как `admin_action_denied`. Требования - ТЗ, разделы 15.6 и 6.15.

Базовый адрес: `https://<VPN_SERVER_HOST>/admin/v1`. Аутентификация: для RU-контура `Authorization: Bearer <ADMIN_API_TOKEN>` из `.env` дашборда и бота, отличается от `tunnel_api_key`, доступ ограничен адресом RU-сервера; для приложения обычный access token с claim `role=admin` и TTL 15 минут. Набор методов у обоих одинаковый, кроме `approve` кода связки и `confirm` pending-действий, которые принимаются только от бота.

| Метод и путь | Кто вызывает | Назначение |
| --- | --- | --- |
| `POST /admin/v1/device-codes/{userCode}/approve` | бот | подтвердить код связки для `userId`: сценарий deep link (`API-016`) |
| `POST /admin/v1/activation-codes` | бот, админка | выдать код активации для ручного ввода |
| `PUT /admin/v1/users/{userId}` | бот, админка | push статуса подписки: `enabled`, `expiresAt`, `deviceLimit` |
| `GET /admin/v1/users/{userId}/devices` | бот, админка | устройства пользователя: платформа, версия, последний sync, возраст whitelist |
| `DELETE /admin/v1/devices/{deviceId}` | бот, админка | отозвать устройство |
| `GET /admin/v1/error-reports` | админка | отчеты с фильтром по fingerprint и устройству |
| `GET /admin/v1/health` | вотчер бота | версия, возраст копии списка, возраст копии статусов, число peer на `wg0` |
| `GET /admin/v1/settings`, `PUT /admin/v1/settings` | приложение (admin), бот | политика клиентов, `trialDays`, `minSupportedVersion`, порядок транспортов (`FR-281`) |
| `GET /admin/v1/users` | приложение (admin) | список пользователей с поиском и пагинацией |
| `POST /admin/v1/users/{userId}/extend`, `.../enable`, `.../disable` | приложение (admin) | те же действия, что в карточке бота; проксируются в дашборд как источник правды |
| `GET /admin/v1/routes`, `POST /admin/v1/routes`, `DELETE /admin/v1/routes/{id}`, `POST /admin/v1/routes/apply` | приложение (admin), релиз 1.1 | группы и записи общего списка; запись идет в `groups`/`ips` дашборда с токеном на запись (`FR-283`) |
| `POST /admin/v1/error-reports/{id}/resolve` | приложение (admin), релиз 1.1 | отметка «решено» |
| `GET /admin/v1/status` | приложение (admin), релиз 1.1 | peer онлайн по транспортам, возраст копий, распределение версий |
| `GET /admin/v1/audit` | приложение (admin) | журнал действий администраторов |

`POST /admin/v1/activation-codes`, запрос:

```json
{ "userId": 2081, "ttlSec": 86400, "issuedBy": "bot:@admin" }
```

Ответ `200`:

```json
{ "code": "XXXX-XXXX-XXXX", "expiresAt": "2026-09-04T12:00:00Z" }
```

`PUT /admin/v1/users/{userId}`, запрос:

```json
{ "enabled": true, "expiresAt": "2026-10-01T00:00:00Z", "deviceLimit": 3, "displayName": "Пользователь" }
```

Обратное направление, `client-api` -> RU-сервер:

| Вызов | Назначение |
| --- | --- |
| `GET /api/routes` с `X-Api-Key` и `If-None-Match` | список маршрутов, раз в 5 минут (`API-110`) |
| `GET /api/tunnel/users` с сервисным токеном | сверка копии статусов раз в 15 минут (`API-111`) |
| `POST /api/notify` с `X-Api-Key` | доставка actionable-ошибок в админ-чаты (`API-113`) |

Требования:

- `API-120` (MUST). Все вызовы admin API идемпотентны по `Idempotency-Key`; повторный `PUT` с теми же данными не создает событий.
- `API-121` (MUST). Код активации привязан к `userId`; при активации `client-api` проверяет копию статуса пользователя и отказывает, если пользователь отключен или подписка истекла, даже если код валиден.
- `API-122` (MUST). `GET /api/tunnel/users` сегодня доступен только под JWT администратора; для сверки дашборд **MUST** принимать сервисный токен с правами только на чтение. Это единственное изменение в `tunnel-dashboard-backend` ради клиентского контура, кроме вызовов admin API из бота и админки.
- `API-123` (MUST). Бот получает обработку `/start link_<код>` для сценария deep link (проверка пользователя и подписки, при необходимости обычный онбординг, затем `approve`) и кнопку «Активировать приложение» в меню пользователя и в карточке администратора для ручного кода. Обе ведут в admin API; логику кодов бот не дублирует.
- `API-124` (MUST). Если `client-api` недоступен для бота, бот честно сообщает об этом, а не выдает код из собственного генератора.

Настройки (`GET /admin/v1/settings`):

```json
{
  "trialDays": 7,
  "deviceLimitDefault": 3,
  "minSupportedVersion": "1.0.0",
  "transports": ["wireguard", "ikev2"],
  "transportTimeoutSec": 15,
  "policy": {
    "syncIntervalSec": 420,
    "watchdogIntervalSec": 60,
    "failClosedDefault": true,
    "failClosedUserOverride": true,
    "staleGraceMultiplier": 3,
    "hardExpirySec": 2592000,
    "maxRoutes": 10000,
    "errorReportRateLimitPerHour": 4
  },
  "updatedAt": "2026-09-03T10:00:00Z",
  "updatedBy": "tg:123456789"
}
```

Требования к admin API для приложения:

- `API-130` (MUST). Все `admin/v1/*` для приложения требуют access token с ролью `admin`; роль проверяется на сервере при каждом запросе (`FR-280`). Бот и админка ходят по своему токену, приложение - по пользовательскому токену с ролью.
- `API-131` (MUST). `PUT /admin/v1/settings` валидирует каждое поле теми же границами, что клиент (`API-031`), и отклоняет весь запрос при одной невалидной настройке. Ответ содержит `updatedAt` и `updatedBy`.
- `API-132` (MUST). Бот читает `trialDays` из `GET /admin/v1/settings` при создании пробной подписки; при недоступности `client-api` использует `tunnel_trial_days` из `.env` (`FR-271`).
- `API-133` (MUST). Правки списка проходят те же guardrails, что `/addip` бота (`validate_routable_cidr`: минимум `/8` для IPv4 и `/16` для IPv6, запрет catch-all), пишутся в дашборд токеном с правом записи только в `groups`/`ips`, а `POST /admin/v1/routes/apply` вызывает control-endpoint менеджера на RU-сервере тем же способом, что кнопка «Применить сейчас» у `/addip`.
- `API-134` (MUST). Каждая мутация через admin API пишет запись в `audit`: время, актор (`tg:<id>` или `bot`, `dashboard`), действие, цель, результат. `GET /admin/v1/audit` отдает журнал с пагинацией (`FR-285`).
- `API-135` (SHOULD). Для `minSupportedVersion` и массового отзыва `client-api` **SHOULD** требовать подтверждение в боте: создает pending-действие, шлет администратору сообщение с кнопкой через `POST /api/notify`, применяет после `POST /admin/v1/pending/{id}/confirm` от бота (`FR-286`).
- `API-136` (MUST). Мутации пользователей из приложения проксируются в дашборд как источник правды и в копию `client-api` одновременно; при недоступности дашборда мутация отклоняется с понятной ошибкой, а не применяется только локально.

### 11.1. Агент провизионинга (отложено)

Нужен только для второй и последующих tunnel-точек, если они не получат собственный экземпляр `client-api`. Набросок: `GET /agent/v1/peers`, `PUT /agent/v1/peers/{publicKey}`, `DELETE /agent/v1/peers/{publicKey}`, `GET /agent/v1/health`; токен на точку, идемпотентность, сверка раз в 5 минут, та же логика `bot/wireguard.py`. В 1.0 не реализуется.
