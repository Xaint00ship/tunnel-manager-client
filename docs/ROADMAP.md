# Tunnel Manager Client: Roadmap

## Phase 0: Specification And Repository Setup

Goal: prepare the repository and agree on the product/technical direction.

Deliverables:

- public repository;
- `README.md`;
- technical specification;
- roadmap;
- initial issue list after specification approval;
- decision record for the chosen stack.

Exit criteria:

- stack approved;
- MVP scope approved;
- first platform confirmed as macOS Apple Silicon.

## Phase 1: App Shell

Goal: create the base Tauri application.

Deliverables:

- Tauri v2 app;
- React + TypeScript frontend;
- package manager and workspace structure;
- linting/formatting;
- basic CI;
- app window with placeholder status screen;
- local development commands.

Exit criteria:

- app runs locally on macOS Apple Silicon;
- CI passes for TypeScript checks and basic build.

## Phase 2: Core TypeScript Logic

Goal: build OS-independent product logic.

Deliverables:

- API client;
- shared API types;
- local cache;
- route list validator;
- route diff engine;
- state machine for connect/sync/error states;
- mock backend for local development.

Exit criteria:

- app can fetch and cache a route list from a mock API;
- route changes produce deterministic add/remove operations;
- unit tests cover core route logic.

## Phase 3: macOS Tunnel Control MVP

Goal: make the app useful on macOS.

Deliverables:

- macOS native adapter skeleton;
- secure storage through Keychain;
- tunnel profile connect/disconnect;
- status detection;
- basic route apply/remove;
- admin permission flow where needed.

Exit criteria:

- user can connect and disconnect from the app;
- app can detect active tunnel interface;
- protected routes are applied while connected.

## Phase 4: Watchdog And Fail-Closed

Goal: protect routing behavior during real-world failures.

Deliverables:

- route drift watchdog;
- route repair;
- fail-closed policy;
- recovery after sleep/wake;
- recovery after network changes;
- diagnostics panel;
- redacted log export.

Exit criteria:

- route drift is repaired automatically;
- protected destinations do not leak when the tunnel is down;
- app recovers after sleep/wake without manual route cleanup.

## Phase 5: Packaging And Distribution For macOS

Goal: prepare a testable macOS build.

Deliverables:

- Apple Silicon build artifact;
- DMG packaging;
- app icon;
- versioning;
- updater decision;
- signing/notarization plan;
- install/uninstall cleanup checks.

Exit criteria:

- a tester can install the app from a DMG;
- app runs after reboot if autostart is enabled;
- uninstall removes helper/routes/config without leaving broken networking.

## Phase 6: Backend API Hardening

Goal: make the control plane safe for real users.

Deliverables:

- client auth endpoints;
- route list versioning;
- route list hash/signature;
- subscription enforcement;
- app version policy;
- event ingestion;
- admin dashboard changes if needed.

Exit criteria:

- expired users cannot receive usable route updates;
- revoked devices stop working after token revocation;
- route list changes propagate to clients within the configured sync interval.

## Phase 7: Windows Adapter

Goal: add Windows desktop support.

Deliverables:

- Windows native adapter;
- secure storage;
- profile setup;
- route sync;
- fail-closed implementation;
- Windows installer;
- Windows CI/build job.

Exit criteria:

- Windows 10/11 users can install, connect, sync routes, and disconnect;
- fail-closed behavior passes manual tests.

## Phase 8: Android Technical Spike

Goal: prove the Android architecture before committing to a full release.

Deliverables:

- Android Tauri shell evaluation;
- system tunnel service prototype;
- background sync prototype;
- always-on behavior analysis;
- Google Play policy checklist;
- decision record.

Exit criteria:

- clear go/no-go decision for Android implementation path;
- known risks and required native work are documented.

## Phase 9: Android MVP

Goal: ship the first Android test build if the spike is successful.

Deliverables:

- Android app build;
- tunnel service;
- route policy sync;
- local cache;
- connection status;
- fail-closed equivalent where supported;
- internal testing build.

Exit criteria:

- Android user can install, connect, and receive route updates;
- app behavior is acceptable under network changes and reboot.

