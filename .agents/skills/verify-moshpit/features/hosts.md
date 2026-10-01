# Hosts and demo controls

Hosts manages browser connections through Tailscale bridge URLs. The same screen provides appearance, terminal preferences, notifications, and PWA installation guidance.

## Sub-features

- Add host opens an accessible dialog with a host name and bridge URL. HTTPS is required except on loopback and, for HTTP-served pages, `*.ts.net` Tailscale names. The dialog also offers `Scan host QR` (camera) and a `Paste host code` field that prefills name and URL. Save persists the profile; Connect pairs the browser and reads the host snapshot.
- Existing profiles without a URL show Bridge URL needed and instructions to add the bridge address. Each saved host row has a `Host QR` dialog for pairing another device.
- Pairing surfaces live on this screen: a pending device approval (name plus `Approve`), an out-of-band pairing-secret entry, a bridge-password unlock, and a `Paired devices` list with expiry and revoke.
- Demo herdr supports Connect and Disconnect. Demo controls simulate blocked agents or stopped herdr, and reset the fixture.
- Appearance includes Moshpit light/dark and the original herdr palettes. Match device appearance selects a light/dark sibling when available.
- Installation guidance is always available; supported browsers expose an install button when they provide an install event.

## How to get to it (user POV)

- Select Hosts, the third primary navigation target.
- Choose Add host to enter a bridge address.
- Use the installation card below the host list to add the PWA to your device.

## Driving it with drive.mjs

- `drive.mjs hosts <port> <evidence-dir>` checks the demo connection, disconnect, reconnect, blocked simulation, and reset.
- `npm run verify:pwa` checks bridge form submission and persistence across reload in Chromium, Firefox, and WebKit.
- `helpers/check-wide.mjs <port>` checks the desktop host/settings columns and navigation.

## Gotchas

- The demo fixture requires `?demo=1`. A fresh normal launch has no sample hosts.
- Connect to a real host only within the task's authorized scope. Verification helpers use isolated demo backends.
- OS installation and push delivery need a physical device.
