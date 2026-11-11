# TripAlogue — Phase 0: Foundations (web)

TripAlogue is a web application for building travelogues from a trip's itinerary, photos and videos, and
(from Phase 7) for building them together with the people who were on the trip. This is Phase 0 of the PRD:
the foundations every later phase plugs into.

**Exit criterion met:** a hand-written project with 20 media items is imported into an account, its originals
are uploaded through the browser, and it plays end to end in the browser from cloud storage
(see [Exit test](#exit-test)).

| PRD | Requirement | Where |
| --- | --- | --- |
| F-1 | Project stored on the server, autosaved, with version history and JSON export and import | `src/server/projects.ts`, `src/web/session.ts`, `src/core/` |
| F-2 | Undo and redo across all edits, at least 100 steps, without undoing other people's changes | `src/core/history.ts` (`rebase`) |
| F-3 | Player at the project's aspect ratio, drawing the shared render model | `src/core/render-model.ts`, `src/player/` |
| F-4 | Media processing jobs: probe, thumbnails, 720p proxies in object storage | `src/server/media.ts` |
| F-5 | Opt-in telemetry hooks for usability sessions | `src/core/telemetry.ts`, `POST /api/telemetry` |
| F-6 | Accounts: email-link sign-in, optional Google sign-in, sessions | `src/server/auth.ts` |
| F-7 | Resumable uploads of unaltered originals | `src/server/uploads.ts`, `src/web/uploader.ts` |
| F-8 | Sharing basics: invitations, roles, one editor at a time | `src/server/projects.ts` |
| F-9 | Operation log: every edit stored with author, time and origin | `src/core/ops.ts`, `src/server/projects.ts` |

## Quick start

Requires Node 22.13 or later (it uses the built-in `node:sqlite`) and `ffmpeg`/`ffprobe` on the PATH.
There are no runtime npm dependencies.

```sh
npm install
npm run build
node --no-warnings dist/node/cli.js serve --data data      # http://127.0.0.1:5173
```

Sign in with any email address. Until an email provider is configured, sign-in and invitation links are
printed in the server console and written to `data/outbox/`.

To load the sample trip into your account without clicking through the import screen:

```sh
node --no-warnings dist/node/cli.js import samples/hand-written-20/trip.travelogue.json --email you@example.com --data data
```

Or use **Import a project file** on the home page and choose `samples/hand-written-20/trip.travelogue.json`
plus the files in `samples/hand-written-20/media/` (run `npm run sample` first if that folder is empty).

### Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `TRIPALOGUE_DATA_DIR` / `--data` | `./data` | Database, object storage, upload temp files, outbox |
| `PORT` / `--port` | `5173` | Listen port |
| `TRIPALOGUE_BASE_URL` / `--base-url` | `http://127.0.0.1:<port>` | Public URL used in links; `https://` turns on Secure cookies |
| `TRIPALOGUE_SECRET` | generated into `<data>/secret` | Key for signed media links |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | unset | Turn on "Sign in with Google" (redirect URI: `<base>/api/auth/google/callback`) |
| `TRIPALOGUE_MAX_UPLOAD_BYTES` | 10 GB | Per-file upload limit |
| `TRIPALOGUE_TELEMETRY_DIR` | unset | Turn on the opt-in telemetry endpoint |

`tripalogue serve --no-worker` plus a separate `tripalogue worker` runs media processing in its own process.

### Tests

```sh
npm run typecheck
npm test            # 61 tests: model, order keys, operations, history, server API, uploads, processing, auth
npm run test:e2e    # browser exit test (needs Playwright's Chromium: npx playwright install chromium)
```

## How it works

```text
Browser (each member)                         Server
  editors + player ── edits as operations ──▶ API: accounts, roles, operation log, versions, edit lock
  shared render model                          SQLite (node:sqlite)
  resumable uploader ─── original bytes ────▶ object storage (file system driver; S3-shaped interface)
                     ◀── signed media links ── media worker: ffprobe, thumbnails, proxies (ffmpeg)
```

- **Edits are operations.** The browser keeps a local undo history. Each edit is diffed into operations
  addressed by entity id (never array index), queued, and saved within about a second. The server applies them,
  stamps who changed each entity, validates the result, and records the batch in the operation log with a new
  revision. Every 50 revisions it keeps an automatic version; members can also save named versions and restore
  any of them (a restore is itself a revision).
- **One editor at a time, for now.** Editors take a one-minute edit lock that the browser renews; others see
  who is editing. A save based on an older revision is accepted only when everything in between came from the
  server (uploads finishing, media processed); those changes are folded into the editor's undo history so undo
  never reverts them. Phase 7 replaces the lock with live merging.
- **Order without renumbering.** Cue order is a fractional key (`src/core/fractional.ts`), so a move changes
  one cue and two people reordering never collide.
- **Originals are never altered.** Uploads are chunked, each chunk must start at the server's offset, and an
  interrupted upload resumes after a reload. The finished file is hashed (sha256) and stored as is; capture
  time and GPS stay intact.
- **Media is private.** Media URLs check membership, then redirect to a signed link that expires after 10 minutes
  and supports byte ranges for video seeking.
- **Roles:** owner (everything, invitations), editor (edit, versions, export), contributor (upload and view),
  viewer (watch). All checks are on the server.
- **Security:** no passwords stored; sign-in tokens and session ids stored only as hashes; HttpOnly SameSite
  session cookies; every write needs an `X-TripAlogue-Client` header (blocks cross-site requests); a strict
  Content-Security-Policy on the app; blob keys cannot leave the store.

## Schema v2

Phase 0 moved the project format to schema v2 (`src/core/schema.ts`): upload-based sources, media storage
fields (`storageKey`, `contentHash`, `status`, `assets`), fractional cue order, and per-entity `updatedBy` and
`updatedAt`. v1 files (like the hand-written sample) are upgraded automatically on import (`src/core/migrate.ts`).

## Exit test

`scripts/exit-test.ts` starts the app on an empty data folder and, in headless Chromium, signs in with an
emailed link, imports the hand-written 20-item project by uploading its files through the browser, waits for
processing, plays the whole travelogue in real time, spot-checks frames, and checks that an edit autosaves,
survives a reload and can be undone. Report and screenshots: `docs/exit-test/`.

| Check | Result |
| --- | --- |
| Upload and process 20 originals (10.1 MB) | all ready about 14 s after import |
| Play 111 s of timeline at 1x | 111.2 s, all 23 segments in order, 0 of 6,669 frames waiting on media, 60 fps |
| Frame checks (title, fit, custom rectangle, fill, trimmed clip, 2x clip) | 6 of 6 |
| Edit → autosave → reload → undo, every change in the operation log | pass |
| Total | 18 of 18 checks |

## Layout

```text
src/core/     platform-neutral model: schema, validation, migrations, order keys, operations, history, autosave, timeline, render model, telemetry
src/server/   web server: config, database, object storage, auth, projects and operation log, uploads, media jobs, mailer
src/web/      browser app: API client, project session (sync, autosave, lock), resumable uploader, UI
src/player/   canvas player and media pool
src/node/     command line (serve, worker, import, validate, info, new) and file helpers
samples/      hand-written 20-item project (schema v1) and its synthetic media generator
test/         unit and API tests (node:test)
scripts/      build, sample media, exit test
```

## Not yet in Phase 0

- An email provider (links go to the console and `data/outbox/`), and an S3-compatible storage driver (the
  interface is ready; the file-system driver ships).
- Exporting an archive of originals alongside the JSON file.
- The editors themselves (itinerary, media manager, presentation editor), timestamp assignment, export to MP4,
  map view, audio lanes, and live co-editing are later phases; their data already has a place in the schema.
