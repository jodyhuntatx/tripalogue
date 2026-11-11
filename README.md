# TripAlogue — Phase 0: Foundations

Phase 0 of the TripAlogue PRD: a project file that saves, loads and plays, so every later phase plugs into a
working shell. **Exit criterion met:** a hand-written project with 20 media items plays end to end in the
player (see [Exit test](#exit-test)).

| PRD | Requirement | Where |
| --- | --- | --- |
| F-1 | Create, open, save and autosave a versioned project file | `src/core/schema.ts`, `project.ts`, `validate.ts`, `migrate.ts`, `autosave.ts`; `src/node/storage.ts` |
| F-2 | Undo and redo across all edits, at least 100 steps | `src/core/history.ts`, `edits.ts` |
| F-3 | Player shell rendering ordered cues at the project's aspect ratio | `src/core/timeline.ts`, `render-model.ts`; `src/player/` |
| F-4 | Thumbnail and proxy cache, outside the project file, safe to delete | `src/node/cache.ts` |
| F-5 | Opt-in telemetry hooks for task timing and errors | `src/core/telemetry.ts`; `POST /api/telemetry` in `src/node/server.ts` |

## Quick start

Requires Node 20+ and `ffmpeg`/`ffprobe` on the PATH.

```sh
npm install
npm run build
npm run sample          # only if samples/hand-written-20/media is missing
node dist/node/cli.js cache samples/hand-written-20/trip.travelogue.json
node dist/node/cli.js serve samples/hand-written-20/trip.travelogue.json
# open http://127.0.0.1:5173/
```

Player keys: Space play/pause · ←/→ 5 s · `[` `]` previous/next chapter · Home/End. Click the picture to play or pause.

### Command line

```text
tripalogue new <file> --title "Trip name" [--aspect 16:9|9:16|1:1]
tripalogue validate <file>        # schema + reference checks, migration and recovery notes
tripalogue info <file>            # chapters, item counts, runtime, skipped items
tripalogue cache <file> [--cache-dir DIR] [--apply-probes]
tripalogue serve <file> [--port N] [--cache-dir DIR] [--telemetry-dir DIR]
```

### Tests

```sh
npm run typecheck
npm test                # 36 unit tests: model, history, autosave, timeline, render model, telemetry, storage, cache, server
npm run test:e2e        # exit test in headless Chromium (needs Playwright's Chromium: npx playwright install chromium)
```

## Decisions Phase 0 made where the PRD leaves things open

- **Platform (PRD open question).** The core (`src/core`) is plain TypeScript with no runtime dependencies and no
  DOM or Node imports, so it can run in a desktop shell (Electron or Tauri), a web app, or both. Phase 0 delivers
  the player as a browser page served by a small local server, which is the same shape a desktop shell would
  embed. The decision itself is still open; nothing here forecloses either answer.
- **Schema covers later phases now.** Chapters carry coordinates, media carries location and an `audio` kind,
  cues carry audio anchors, and the project has audio lanes and map-view settings. Later phases fill these in
  without a format change. A worked migration (v0 draft → v1) shows how future changes upgrade old files.
- **Shared render model.** `frameAt(timeline, t, frameSize)` is a pure function returning the layers to draw.
  The player draws them on a canvas; the Phase 4 exporter will draw the same layers into video frames, which is
  what makes the 1-frame preview/export parity targets testable.
- **Undo history via structural sharing.** Edits return new objects that share unchanged branches, so 200
  snapshots of a large project cost only what changed. Rapid edits with the same key (a drag) merge into one step.
- **Autosave never touches the saved file.** It writes a `<file>.autosave` sidecar every 30 s while dirty and
  within 0.75 s of a structural edit. On open, a newer sidecar is offered as crash recovery; saving clears it.
  Saves are atomic (temp file, fsync, rename).
- **Cache location.** `~/.cache/tripalogue` (Linux), `~/Library/Caches/tripalogue` (macOS),
  `%LOCALAPPDATA%\tripalogue` (Windows), or `$TRIPALOGUE_CACHE`. Entries are keyed by the original's path, size and
  modified time; proxies are 720p H.264 with a keyframe every second so seeking is fast. The cache refuses any
  folder inside, or containing, the project folder or a media folder, so deleting it can never touch originals.
- **Telemetry is off unless both sides opt in**: the user opens the player with `?telemetry=1` *and* the server is
  started with `--telemetry-dir`. A visible "Session recording on" badge shows when it is active. Events carry
  ids, counts, durations and flags only; keys that could carry paths, titles, text or locations are dropped.
- **The server only serves media by item id**, never by path, and binds to 127.0.0.1.
- **Default cue values** are the PRD's proposals (Section 3): images 4 s, videos up to 15 s, 0.5 s fades, 3 s title
  cards.

## Exit test

`scripts/exit-test.ts` builds the cache, serves `samples/hand-written-20`, and plays it in headless Chromium in
real time. It checks that all 23 segments (4 chapter title cards + 19 included items; 1 item is deliberately
excluded) are entered in order, no media fails, nothing waits on loading, nothing is logged as an error, the
frame rate holds, and frames at seven known times show the expected placement. Results and screenshots are in
`docs/exit-test/`.

| Run | Timeline | Wall clock | Frames waiting on media | Checks |
| --- | --- | --- | --- | --- |
| Cache proxies, 1x | 111 s | 111.2 s | 0 of 6,661 | 18 of 18 |
| Original files, 1x | 111 s | 111.2 s | 0 of 6,662 | 18 of 18 |

## Layout

```text
src/core/      platform-neutral model: schema, validation, migrations, history, autosave, timeline, render model, telemetry
src/node/      file storage, media cache (ffmpeg), local preview server, CLI
src/player/    browser player shell (canvas), bundled to dist/player
samples/       hand-written 20-item project + generator for its synthetic media
test/          unit tests (node:test via tsx)
scripts/       build, sample-media generator, exit test
docs/          exit-test report and screenshots
```

## Not in Phase 0

Editors (itinerary, media manager, presentation editor), import and timestamp assignment, Ken Burns motion,
annotations, audio lanes, the map view and video export are later phases; their data has a place in the schema
but no behaviour yet. Video plays with its own sound; there is no mixer yet.
