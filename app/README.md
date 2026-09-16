# Tunnel Manager Client Desktop

Electron desktop client forked from `magnetgate/app` and adapted for macOS-first development.

The app runs the discovery/native client with bundled Node, then starts `sing-box` TUN for Full or
Split routing. On macOS the `sing-box` binary is `tools/sing-box/sing-box`; install it from the
repository root with:

```bash
bash scripts/get-singbox-macos.sh
```

Local development:

```bash
npm ci
npm run install:electron
npm test
npm start
```

macOS packaging:

```bash
npm run dist:mac
```

The imported Windows firewall guard is intentionally disabled on macOS. Full/Split routing is active
through `sing-box` TUN, while a persistent macOS kill-switch still needs a dedicated helper or Network
Extension design.
