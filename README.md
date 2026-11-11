# TripAlogue — Phase 1: Itinerary editor (web)

TripAlogue is a web application for building travelogues from a trip's itinerary, photos and videos, and
(from Phase 7) for building them together with the people who were on the trip. This is Phase 0 of the PRD:
the foundations every later phase plugs into, plus Phase 1: the itinerary editor
(see [Phase 1](#phase-1-itinerary-editor)).

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

Requires Node 22.13 or later (it uses the built-in `node:sqlite`) and `ffmpeg`/`ffprobe` on the PATH
(see [Installing ffmpeg](#installing-ffmpeg)). There are no runtime npm dependencies.

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

### Installing ffmpeg

TripAlogue uses the `ffmpeg` and `ffprobe` command-line tools to read each uploaded photo and video and to
make thumbnails and preview copies. Install them before starting the server:

| System | Command |
| --- | --- |
| macOS (Homebrew) | `brew install ffmpeg` |
| macOS (MacPorts) | `sudo port install ffmpeg` |
| Ubuntu / Debian | `sudo apt install ffmpeg` |
| Fedora | `sudo dnf install ffmpeg` (from RPM Fusion) |
| Windows | `winget install Gyan.FFmpeg` |

Check that both tools are on your PATH, then start (or restart) the server from a new terminal window so it
picks up the updated PATH:

```sh
ffmpeg -version
ffprobe -version
```

If uploads finish but items show **failed · spawn ffprobe ENOENT**, the server could not find `ffprobe`.
Install ffmpeg as above, restart the server, then upload those files again from the project's **Upload** tab.

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
| `TRIPALOGUE_HEIC_CONVERTER` | `auto` | HEIC photo converter: `auto`, `off`, or one of `ffmpeg`, `heif-dec`, `heif-convert`, `sips`, `magick`, `convert` |
| `TRIPALOGUE_GEOCODER_URL` | Nominatim (`https://nominatim.openstreetmap.org/search`) | Place search; empty turns it off |
| `TRIPALOGUE_TILE_URL` | `https://tile.openstreetmap.org/{z}/{x}/{y}.png` | Map tiles; empty shows a plain grid |
| `TRIPALOGUE_TILE_ATTRIBUTION` | `© OpenStreetMap contributors` | Credit shown on the map |
| `TRIPALOGUE_CONTACT_EMAIL` | unset | Added to the User-Agent sent to the geocoder, as Nominatim's policy asks |

Place search and tiles go through the server, which caches them (searches for a week, tiles under
`<data>/tiles`) and spaces searches at least a second apart. The OpenStreetMap defaults are for local testing
only; their public servers are not meant for production traffic. The production provider is an open PRD
question.

`tripalogue serve --no-worker` plus a separate `tripalogue worker` runs media processing in its own process.

### HEIC photos

iPhones and many Android phones save photos as HEIC, which most browsers can't show. TripAlogue keeps the
uploaded HEIC unaltered and makes a full-resolution JPG from it (rotation applied, capture time and location
kept); the thumbnail and playback proxy come from that JPG, and a **JPG** link next to the item in the Items list
downloads it. No extra install is needed: the built-in converter reads the HEIC itself and decodes its HEVC
picture tiles with ffmpeg. libheif (`heif-dec`), macOS `sips` and ImageMagick are used as fallbacks for layouts
the built-in reader doesn't cover. Each converter must turn a small sample HEIC into a correct JPG at startup
before it's used, and the log says which ones are in use.

Ordinary JPEGs that phones save sideways with an orientation tag are turned upright the same way on every ffmpeg
version (ffmpeg's own automatic rotation is switched off and the tag is applied explicitly).

### Tests

```sh
npm run typecheck
npm test            # 95 tests: model, order keys, operations, history, itinerary, geo proxy, server API, uploads, processing, auth
npm run test:e2e    # Phase 0 browser exit test (needs Playwright's Chromium: npx playwright install chromium)
npm run test:phase1 # Phase 1 browser test of the G1 tasks (no internet needed: it uses a stand-in map provider)
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
| Map inset: whole trip on a title card, then the chapter being played | pass |
| Hide the side panel: the player fills the width, the choice is remembered, P toggles it | pass |
| A HEIC photo uploads through the browser, gets a full-size JPG, and shows upright | pass |
| Total | 22 of 22 checks |

## Phase 1: Itinerary editor

A travelogue opens in the **Itinerary** view until it has chapters and media; **Play** is one click away and
keeps the same session.

| PRD | Requirement | Where |
| --- | --- | --- |
| IT-1 | Chapters with title, place, start and end in the chapter's own time zone, description | `src/core/itinerary.ts`, `src/web/itinerary.ts` |
| IT-2 | Add, insert, reorder, sort by date, delete (media moves to Unassigned) | same |
| IT-3 | Timeline of chapters in lanes, linked to the cards and the map | `src/web/itinerary.ts` |
| IT-4 | Overlap, gap and order checks in plain words; back-to-back chapters are not flagged | `analyzeItinerary` |
| IT-5 | Chapter title cards (on or off, seconds) and a Play button that runs them | `src/web/main.ts` |
| IT-6 | Paste lines or choose a CSV, preview, then add (undoable); consecutive days in one place fold into one chapter | `parseItinerary` |
| IT-7 | Split a chapter at a time (media moves by timestamp) and merge with the next | `splitChapter`, `mergeChapters` |
| IT-8 | Place search, or drop a pin by clicking the map | `src/server/geo.ts`, `src/web/map.ts` |
| MV-1 | Route map: numbered pins joined in order; selecting a pin selects its chapter and the reverse | `src/web/map.ts` |
| MV-9 | Basic playback inset: a corner map in Play that shows the whole trip on each title card, then flies in to the chapter being played; visited chapters marked, route ahead dashed; on/off, corner, size and shape under **Map** in the player controls | `src/web/inset.ts` |

Moving a start past its end (or an end before its start) keeps the chapter's length, so an edit never leaves an
invalid chapter. Numeric dates in pasted text are read month/day/year.

In Play, **Hide panel** (or the P key) folds away the Items, Upload, Members and Versions panel so the player
uses the whole width; the browser remembers the choice.

The inset is on for new travelogues. For a travelogue made before it existed, open **Map** next to Mute in the
Play view and tick **Show map inset**. It is preview only: per-photo locations, the animated travel
transition, per-chapter settings and drawing it into exported video come with the full map view in Phase 5.

`scripts/phase1-test.ts` scripts the G1 usability tasks in headless Chromium against a stand-in map provider:
create a travelogue, paste six lines (one bad) and add five chapters from the preview, add three more by hand
with place search, drop a pin on the map, split a three-day chapter, find and fix a planted overlap, undo and
redo, reload, play the nine title cards, and check the map inset (trip view on title cards, chapter view,
moving, hiding and undo). Report and screenshots: `docs/phase1-test/`. Result: 20 of 20 checks, with no
browser console errors. The Phase 0 exit test, now 22 checks, adds the inset following the sample's chapters, the hideable side panel and a HEIC upload.

## Layout

```text
src/core/     platform-neutral model: schema, validation, migrations, order keys, operations, history, autosave, timeline, render model, telemetry
src/server/   web server: config, database, object storage, auth, projects and operation log, uploads, media jobs (with HEIC conversion and photo orientation), mailer, geo proxy
src/web/      browser app: API client, project session (sync, autosave, lock), resumable uploader, itinerary view, route map, UI
src/player/   canvas player and media pool
src/node/     command line (serve, worker, import, validate, info, new) and file helpers
samples/      hand-written 20-item project (schema v1) and its synthetic media generator
test/         unit and API tests (node:test)
scripts/      build, sample media, exit test, Phase 1 test
```

## Not built yet

- An email provider (links go to the console and `data/outbox/`), and an S3-compatible storage driver (the
  interface is ready; the file-system driver ships).
- Exporting an archive of originals alongside the JSON file.
- A production map provider (see Configuration), and a hosted test site.
- The media manager, timestamp assignment, presentation editor, export to MP4, the full inset map, audio lanes,
  and live co-editing are later phases; their data already has a place in the schema.
