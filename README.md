# Tunnel Manager Client

Tunnel Manager Client is a cross-platform client application that keeps protected routes synchronized on a user's own device. The goal is to remove the need for a regional gateway server and let every client connect directly to the configured tunnel endpoint while receiving route rules from a central API.

The first target platform is macOS on Apple Silicon. Windows and Android support are planned after the macOS MVP is stable.

## Product Goal

The app should:

- connect a user's device to a managed tunnel endpoint;
- sync the route allowlist from the backend every 5-10 minutes;
- cache the latest route list locally;
- route only configured destinations through the tunnel;
- prevent protected destinations from leaking through the regular network if the tunnel is unavailable;
- show clear connection, sync, and diagnostic status to the user.

The client must not connect directly to the database. It should communicate with a backend API that validates the user, subscription state, app version, and route list access.

## Tech Direction

Recommended stack:

- Tauri v2 for the app shell;
- React + TypeScript for UI and most product logic;
- TypeScript packages for API access, route diffing, local cache, and app state;
- small native adapters for operating-system integration;
- a privileged helper where the OS requires elevated permissions.

System-level tunnel and route management cannot be implemented safely with TypeScript alone on all platforms. TypeScript should remain the main product language, while native code is limited to narrow platform adapters.

## Planned Platforms

- macOS Apple Silicon: first MVP target.
- Windows 10/11: second desktop target.
- Android: planned after a technical spike around the system tunnel service model.

## Repository Status

This repository currently contains the initial technical specification and development roadmap. Application code will be added after the specification is approved.

## Documents

- [Technical Specification](docs/TECH_SPEC.md)
- [Roadmap](docs/ROADMAP.md)

