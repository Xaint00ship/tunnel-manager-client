# Tunnel Manager Client: Technical Specification

## 1. Summary

Tunnel Manager Client is a desktop and mobile application that installs on the user's device and manages protected split-routing locally. The backend remains responsible for users, subscriptions, route lists, endpoint metadata, and analytics. The client is responsible for connecting the device, syncing the allowlist, applying local routes, and preventing protected traffic from leaving through the regular network when the tunnel is down.

The first release targets macOS on Apple Silicon. Windows and Android support must be designed into the architecture from the start, but not shipped in the first MVP.

## 2. Goals

- Remove the need for a regional relay/gateway server.
- Keep only foreign tunnel endpoints and a lightweight backend/control plane.
- Move route synchronization and route enforcement to each user's device.
- Keep most application code in TypeScript.
- Reuse behavior from the existing Tunnel Manager service where possible.
- Make the product simple for end users: install, sign in, connect, and forget.

## 3. Non-Goals For MVP

- No direct database access from the client.
- No traffic content inspection.
- No enterprise MDM deployment in the first release.
- No Linux client in the first release.
- No full Android release before a dedicated technical spike.
- No public exposure of infrastructure secrets, server addresses, private keys, tokens, or admin-only endpoints.

## 4. Product Requirements

### 4.1 User Flow

1. User installs Tunnel Manager Client.
2. User signs in or activates the device with an issued account/token.
3. Client fetches subscription and endpoint metadata from the backend API.
4. User presses Connect.
5. Client starts the system tunnel connection.
6. Client downloads and applies the latest allowlist.
7. Client keeps routes synchronized in the background.
8. User can disconnect manually.
9. If access expires, client disconnects and removes protected routes.

### 4.2 Main Screen

The main screen should show:

- connection state;
- account/subscription state;
- remaining access time;
- last successful route sync time;
- number of active protected routes;
- current app version;
- short actionable error when something is wrong.

### 4.3 Background Behavior

The app should:

- sync allowlist every 5-10 minutes;
- keep a local cache of the last valid allowlist;
- run a watchdog for route drift;
- restore missing routes automatically;
- remove obsolete routes after list updates;
- survive sleep/wake, network changes, and endpoint reconnection;
- start automatically after OS reboot when the user enables autostart.

### 4.4 Fail-Closed Behavior

If the tunnel is unavailable, protected destinations must not fall back to the regular network. The exact implementation depends on the platform:

- macOS: route/firewall rules through a privileged helper or system network extension.
- Windows: route table plus Windows filtering rules where needed.
- Android: tunnel service rules inside the Android system tunnel service.

Fail-closed must be configurable by policy, but enabled by default.

### 4.5 Local Cache

The client stores:

- latest valid allowlist;
- allowlist version/hash;
- last sync timestamp;
- user/session metadata;
- non-secret app preferences.

Secrets must be stored in OS-secure storage:

- macOS Keychain;
- Windows Credential Manager or DPAPI;
- Android Keystore.

### 4.6 Diagnostics

The client should expose:

- connection status;
- current tunnel interface;
- route count;
- last sync error;
- backend reachability status;
- endpoint reachability status;
- exportable diagnostic bundle with logs and redacted config.

Diagnostic exports must redact secrets.

## 5. Backend API Requirements

The client talks only to the backend API, not to the database.

Required endpoints:

- `POST /client/v1/auth/activate`
- `POST /client/v1/auth/refresh`
- `GET /client/v1/profile`
- `GET /client/v1/routes`
- `GET /client/v1/endpoint`
- `POST /client/v1/events`
- `POST /client/v1/diagnostics`

### 5.1 Route List Response

The route list should include:

- list version;
- content hash;
- generated timestamp;
- TTL;
- grouped services;
- IPv4 CIDRs;
- IPv6 CIDRs when supported;
- optional emergency blocklist;
- minimum supported app version.

The client must ignore invalid CIDRs and report validation errors.

### 5.2 Events

The client should send lightweight events:

- app started;
- connection started/stopped;
- route sync succeeded/failed;
- fail-closed activated/deactivated;
- subscription expired;
- app version.

Events must not include visited URLs, payload contents, browsing history, or traffic content.

## 6. Architecture

Recommended monorepo layout:

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

The TypeScript core owns:

- API client;
- route list validation;
- route diffing;
- app state machine;
- retry/backoff policies;
- local cache format;
- diagnostic model;
- UI-facing status model.

### 6.2 Native Layer

The native layer owns:

- starting/stopping the OS tunnel profile;
- reading active network interfaces;
- applying/removing routes;
- applying fail-closed rules;
- secure secret storage;
- OS-specific autostart integration.

The native layer must expose a small command API to the TypeScript app.

### 6.3 Suggested Command API

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

## 7. Platform Notes

### 7.1 macOS Apple Silicon

The macOS MVP should start with the least risky implementation:

- Tauri desktop app;
- helper process for privileged route operations;
- OS tunnel profile management;
- Keychain for secrets;
- LaunchAgent/LaunchDaemon for background work if needed.

Open question for implementation:

- use existing OS tunnel profile flow first;
- or move to NetworkExtension if profile control becomes too limited.

### 7.2 Windows

Windows support should use:

- native desktop app build through Tauri;
- PowerShell/VPN client APIs for profile and route setup where reliable;
- Windows Filtering Platform or firewall rules for fail-closed if route-only behavior is insufficient;
- Credential Manager/DPAPI for secrets;
- scheduled task or service for background behavior.

### 7.3 Android

Android requires a separate technical spike. It should likely use Android's system tunnel service model and cannot be treated like desktop route management.

Key questions:

- whether to implement the tunnel fully in-app;
- whether to embed an existing tunnel library;
- how to keep a consistent product UX with desktop;
- how to support always-on behavior.

## 8. Security Requirements

- No direct database access from clients.
- No hardcoded production secrets.
- API access tokens must be revocable.
- Route lists should be signed or hash-validated.
- Backend should enforce subscription/access state.
- Client should pin minimum API compatibility.
- Logs must redact secrets and endpoint credentials.
- Public repository must not contain production infrastructure details.

## 9. Testing Requirements

### 9.1 Unit Tests

- route validation;
- route aggregation;
- route diffing;
- cache expiration;
- retry/backoff behavior;
- subscription state transitions.

### 9.2 Integration Tests

- mock backend API;
- route sync with changed lists;
- offline startup from local cache;
- expired subscription;
- invalid route list handling.

### 9.3 Manual Platform Tests

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

## 10. Open Questions

- Exact user activation model: email link, device code, Telegram approval, or admin-issued invite.
- Exact tunnel transport for the first release.
- Whether one user can activate multiple devices.
- Whether route lists differ by tariff/user/group.
- Required level of traffic accounting on the client side.
- Distribution model: direct DMG download, signed/notarized app, or store distribution.

