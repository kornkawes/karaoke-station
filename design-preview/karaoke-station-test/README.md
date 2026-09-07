# KaraokeStation theme integration sandbox

This folder is isolated from the production app. `contract-fixture.html` renders a documented Hosted room state shape locally and makes **no network request by default**.

To check a running hosted development server, enter a loopback URL, room ID, and a session token, then click the read-only check. The token is not persisted. The check requests only `GET /api/v1/health`, `GET /api/v1/rooms/:roomId/queue`, and `GET /api/v1/rooms/:roomId/history`.

For terminal use:

```powershell
node verify-hosted-contract.mjs --base-url http://127.0.0.1:3000 --room-id ROOM_ID --token TOKEN
```

It accepts only loopback targets unless `--allow-remote true` is explicit. Do not serve the repository root for this sandbox; if browser testing is needed, serve `design-preview` alone from a local static server.

## Compatibility result

The theme can be brought into KaraokeStation, but not by copying this static preview into `src`. The current Hosted contract already supplies the required queue, current track, history, fair-queue setting, revision, token authorization, and room events. Integration requires React components to call `hostedApi` and subscribe through `connectRoom`, while preserving server authority and revision handling.

The read-only verifier was run against a temporary local Hosted server: `health 200`, `queue 200`, and `history 200`, with the expected room and history shapes. No production file was changed by that check.

The sandbox does not test or replace Socket.IO, session expiry/revocation, YouTube resolution, QR invitation generation, multi-device auth, video playback, server validation, or mutation endpoints. It deliberately does not send mutations.
