# TripAlogue — Phase 4: Video export

TripAlogue builds travelogues from a trip's itinerary, photos and videos. It is a standalone app for one person:
installed on your computer, run from your browser, with no account and no sign-in. Nothing leaves your computer
except place searches and map tiles. This is Phase 0 of the PRD:
the foundations every later phase plugs into, plus Phase 1: the itinerary editor
(see [Phase 1](#phase-1-itinerary-editor)), Phase 2: the media manager (see [Phase 2](#phase-2-media-manager)),
Phase 3: the presentation editor, with narration and music lanes (see [Phase 3](#phase-3-presentation-editor)), and
Phase 4: export to MP4 (see [Phase 4](#phase-4-video-export)).

**Exit criterion met:** a hand-written project with 20 media items is imported, its originals are added through
the browser, and it plays end to end from the app's media store (see [Exit test](#exit-test)).

| PRD | Requirement | Where |
| --- | --- | --- |
| F-1 | Project stored by the local server, autosaved, with version history and JSON export and import | `src/server/projects.ts`, `src/web/session.ts`, `src/core/` |
| F-2 | Undo and redo across all edits, at least 100 steps, without undoing changes the server made (uploads, processing) | `src/core/history.ts` (`rebase`) |
| F-3 | Player at the project's aspect ratio, drawing the shared render model | `src/core/render-model.ts`, `src/player/` |
| F-4 | Media processing jobs: probe, thumbnails, 720p proxies in object storage; HEIC to JPG; startup check of ffmpeg; retry after a failure | `src/server/media.ts`, `heic.ts`, `heif.ts`, `toolcheck.ts` |
| F-5 | Opt-in telemetry hooks for usability sessions | `src/core/telemetry.ts`, `POST /api/telemetry` |
| F-6 | One local user, no sign-in; the app answers only on this computer | `src/server/auth.ts`, `src/server/app.ts` |
| F-7 | Resumable uploads of unaltered originals | `src/server/uploads.ts`, `src/web/uploader.ts` |
| F-8 | One window edits at a time (an edit lock) | `src/server/projects.ts` |
| F-9 | Operation log: every edit stored with author, time and origin | `src/core/ops.ts`, `src/server/projects.ts` |

## Quick start

Requires Node 22.13 or later (it uses the built-in `node:sqlite`) and `ffmpeg`/`ffprobe` on the PATH
(see [Installing ffmpeg](#installing-ffmpeg)). There are no runtime npm dependencies.

```sh
npm install
npm run build
npm start           # opens http://127.0.0.1:5173 in your browser; Ctrl+C stops it
```

There is nothing to sign in to: the app runs for you, on this computer, and keeps everything in `./data`
(travelogues, your original files, thumbnails). It listens on 127.0.0.1 only, so other computers on your network
cannot reach it. `node --no-warnings dist/node/cli.js serve --data <folder>` runs it without opening the browser,
with the data kept elsewhere.

To load the sample trip without clicking through the import screen:

```sh
node --no-warnings dist/node/cli.js import samples/hand-written-20/trip.travelogue.json --data data
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

The server checks ffmpeg and ffprobe at startup, including the codecs processing needs, and logs any problem in
plain words. The project's **Upload** tab shows the same warning. After installing or fixing ffmpeg, press
**Check again** in that warning (restart the server if ffmpeg still isn't found, so it picks up the new PATH).
Items that failed while ffmpeg was missing keep their uploaded originals: press **Retry processing** in the
Upload tab (Itinerary view, lower right), or **Retry** next to an item in the Items list, to process them again without re-uploading.

### Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `TRIPALOGUE_DATA_DIR` / `--data` | `./data` | Database, media store, upload temp files |
| `PORT` / `--port` | `5173` | Listen port (always on 127.0.0.1) |
| `--open` | off (`npm start` turns it on) | Open the app in your default browser |
| `TRIPALOGUE_SECRET` | generated into `<data>/secret` | Key for signed media links |
| `TRIPALOGUE_MAX_UPLOAD_BYTES` | 10 GB | Per-file upload limit |
| `TRIPALOGUE_TELEMETRY_DIR` | unset | Turn on the opt-in telemetry endpoint |
| `TRIPALOGUE_HEIC_CONVERTER` | `auto` | HEIC photo converter: `auto`, `off`, or one of `ffmpeg`, `heif-dec`, `heif-convert`, `sips`, `magick`, `convert` |
| `TRIPALOGUE_PURGE_AFTER_DAYS` | `30` | Days removed items wait in the Removed bin before their files are erased |
| `TRIPALOGUE_GEOCODER_URL` | Nominatim (`https://nominatim.openstreetmap.org/search`) | Place search; empty turns it off |
| `TRIPALOGUE_TILE_URL` | `https://tile.openstreetmap.org/{z}/{x}/{y}.png` | Map tiles; empty shows a plain grid |
| `TRIPALOGUE_TILE_ATTRIBUTION` | `© OpenStreetMap contributors` | Credit shown on the map |
| `TRIPALOGUE_CONTACT_EMAIL` | unset | Added to the User-Agent sent to the geocoder, as Nominatim's policy asks |

Place search and tiles go through the server, which caches them (searches for a week, tiles under
`<data>/tiles`) and spaces searches at least a second apart, as OpenStreetMap's usage policies ask of a personal
app. Set `TRIPALOGUE_CONTACT_EMAIL` so their operators can reach you if needed.

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

**What each platform needs.** The built-in converter needs only ffmpeg with its HEVC decoder, which every
standard ffmpeg build includes (the same ffmpeg as in [Installing ffmpeg](#installing-ffmpeg)). The fallbacks
are optional; install one if you expect HEIC files the built-in reader can't handle.

| Platform | Required | Optional fallback |
| --- | --- | --- |
| macOS | ffmpeg | none needed: `sips` is built in (or `brew install libheif`) |
| Ubuntu 24.04 and later, Debian 13 | ffmpeg | `sudo apt install libheif-examples libheif-plugin-libde265` |
| Ubuntu 22.04 and earlier, Debian 12 | ffmpeg | `sudo apt install libheif-examples` (provides `heif-convert`) |
| Fedora | ffmpeg from RPM Fusion, as above | `sudo dnf install libheif-tools libheif-freeworld` (libheif-freeworld is in RPM Fusion) |
| Windows | ffmpeg | ImageMagick from imagemagick.org (its installer includes HEIC support) |

The libheif HEVC decoder is the usual trap. Newer Ubuntu and Debian releases ship libheif's decoders as separate
plugin packages: without `libheif-plugin-libde265`, libheif (and ImageMagick, which uses it) lists HEIC as
supported but cannot decode the picture. TripAlogue converts a small sample HEIC with each tool at startup and
skips any that fail, so a half-installed fallback is ignored rather than producing errors. The startup log names
the converters in use, for example `HEIC photos: converting with ffmpeg, then heif-dec`. If HEIC uploads fail
with "could not be converted", check that line, and that `ffmpeg -decoders | grep hevc` lists a decoder.

### Tests

```sh
npm run typecheck
npm test            # 169 tests: model, order keys, operations, history, itinerary, assignment, metadata, travelers, sample hash, geo proxy, HEIC, presentation edits, audio mix, export plan and MP4 render, server API, uploads, processing, retry, local-only access
npm run test:e2e    # Phase 0 browser exit test (needs Playwright's Chromium: npx playwright install chromium)
npm run test:phase1 # Phase 1 browser test of the G1 tasks (no internet needed: it uses a stand-in map provider)
npm run test:phase2 # Phase 2 browser test of the G2 tasks (your photos and two travelers', a slow camera, WhatsApp copies, a folder upload)
npm run test:phase3 # Phase 3 browser test of the G3 tasks (cut a 12-minute draft to 5, place portraits, lay music) and a 300-item playback
npm run test:phase4 # Phase 4 browser test of the G4 tasks (export at 1080p while editing, a phone version, cancel, a failure) and the export acceptance checks
```

## How it works

```text
Your browser                                  Local server (127.0.0.1)
  editors + player ── edits as operations ──▶ API: operation log, versions, edit lock
  shared render model                          SQLite (node:sqlite)
  resumable uploader ─── original bytes ────▶ media store (files under <data>/blobs)
                     ◀── signed media links ── media worker: ffprobe, thumbnails, proxies (ffmpeg)
```

- **Edits are operations.** The browser keeps a local undo history. Each edit is diffed into operations
  addressed by entity id (never array index), queued, and saved within about a second. The server applies them,
  stamps who changed each entity, validates the result, and records the batch in the operation log with a new
  revision. Every 50 revisions it keeps an automatic version; you can also save named versions and restore
  any of them (a restore is itself a revision).
- **One window edits at a time.** The window you edit in holds a one-minute edit lock that it renews. A save
  based on an older revision is accepted only when everything in between came from the server (uploads
  finishing, media processed); those changes are folded into the undo history so undo never reverts them.
- **Order without renumbering.** Cue order is a fractional key (`src/core/fractional.ts`), so a move changes
  one cue.
- **Originals are never altered.** Uploads are chunked, each chunk must start at the server's offset, and an
  interrupted upload resumes after a reload. The finished file is hashed (sha256) and stored as is; capture
  time and GPS stay intact.
- **Media stays on this computer.** Media URLs redirect to a signed link that expires after 10 minutes and
  supports byte ranges for video seeking.
- **Only you, only here.** No accounts and no sign-in. The server listens on 127.0.0.1, answers only requests
  whose Host is localhost (which defeats DNS-rebinding pages), and every write needs an `X-TripAlogue-Client`
  header (which other web sites cannot send). A strict Content-Security-Policy on the app; blob keys cannot
  leave the store.

## Schema v2

Phase 0 moved the project format to schema v2 (`src/core/schema.ts`): upload-based sources, media storage
fields (`storageKey`, `contentHash`, `status`, `assets`), fractional cue order, and per-entity `updatedBy` and
`updatedAt`. v1 files (like the hand-written sample) are upgraded automatically on import (`src/core/migrate.ts`).

## Exit test

`scripts/exit-test.ts` starts the app on an empty data folder and, in headless Chromium, opens it (no sign-in),
imports the hand-written 20-item project by uploading its files through the browser, waits for
processing, plays the whole travelogue in real time, spot-checks frames, and checks that an edit autosaves,
survives a reload and can be undone. Report and screenshots: `docs/exit-test/`.

| Check | Result |
| --- | --- |
| Open the app with no sign-in | pass |
| Upload and process 20 originals (10.1 MB) | all ready about 14 s after import |
| Play 116 s of timeline at 1x | 116.2 s, all 23 segments in order, 0 of 6,971 frames waiting on media, 60 fps |
| Frame checks (title, fit, custom rectangle, fill, full-length clip, 2x clip) | 6 of 6 |
| Edit → autosave → reload → undo, every change in the operation log | pass |
| Map inset: whole trip on a title card, then the chapter being played | pass |
| Map inset: photo locations as dots, a trail through the chapter so far, the marker hopping to each new item | pass |
| Preview has no side panel and is wider than Mix; Mix's panel hides, is remembered, P toggles it | pass |
| A HEIC photo uploads through the browser, gets a full-size JPG, and shows upright | pass |
| A broken ffmpeg is reported in the Upload tab, and Retry processes failed uploads once fixed | pass |
| Total | 24 of 24 checks |

## Phase 1: Itinerary editor

The views follow the workflow, left to right: **Itinerary** (plan the chapters), **Media** (upload and sort into
chapters), **Mix** (cut, time and lay audio), **Preview** (watch); export to video comes in Phase 4. A travelogue
opens in the **Itinerary** view until it has chapters and media. Switching views keeps the same session. Links to
the old `/edit` and `/play` views still open Mix and Preview.

| PRD | Requirement | Where |
| --- | --- | --- |
| IT-1 | Chapters with title, place, start and end in the chapter's own time zone, description | `src/core/itinerary.ts`, `src/web/itinerary.ts` |
| IT-2 | Add, insert, reorder, sort by date, delete (media moves to Unassigned) | same |
| IT-3 | Timeline of chapters in lanes, linked to the cards and the map | `src/web/itinerary.ts` |
| IT-4 | Overlap, gap and order checks in plain words; back-to-back chapters are not flagged | `analyzeItinerary` |
| IT-5 | Chapter title cards (on or off, seconds) showing the title, place, dates and the chapter's description ("What happened here", wrapped to four lines), and a Play button that runs them | `src/web/main.ts`, `src/player/player.ts` |
| IT-6 | Paste lines or choose a CSV, preview, then add (undoable); consecutive days in one place fold into one chapter | `parseItinerary` |
| IT-7 | Split a chapter at a time (media moves by timestamp) and merge with the next | `splitChapter`, `mergeChapters` |
| IT-8 | Place search, or drop a pin by clicking the map | `src/server/geo.ts`, `src/web/map.ts` |
| MV-1 | Route map: numbered pins joined in order; selecting a pin selects its chapter and the reverse | `src/web/map.ts` |
| MV-9 | Basic playback inset: a corner map in the player that shows the whole trip on each title card, then flies in to the chapter being played; visited chapters marked, route ahead dashed; photos and videos with a location as dots, with a trail through the chapter so far and a marker that hops to each item as it plays; on/off, corner, size and shape under **Map** in the player controls | `src/web/inset.ts` |

Moving a start past its end (or an end before its start) keeps the chapter's length, so an edit never leaves an
invalid chapter. Numeric dates in pasted text are read month/day/year.

**Preview** is just the player at full width. **Mix** has a side panel with the selected **Clip** and the **Items**
list; **Hide panel** (or the P key) folds it away, and the browser remembers the choice. The travelogue panel —
**Upload** and **Versions** — sits in the **Itinerary** view's lower right, under the map and the chapter
timeline, with **Delete this travelogue** below it.

The inset is on for new travelogues. For a travelogue made before it existed, open **Map** next to Mute in
Preview and tick **Show map inset**. While a chapter plays, the inset frames that chapter's located photos and
videos: those still to come are rings, those already shown are filled and joined by a trail in play order, and
the marker travels to each new item and pulses as it arrives (unless **Animate between views** is off). Items
more than 50 km from the chapter's place are drawn but don't widen the view. It is preview only: the animated travel
transition between chapters, per-chapter settings and drawing it into exported video come with the full map view in Phase 5.

`scripts/phase1-test.ts` scripts the G1 usability tasks in headless Chromium against a stand-in map provider:
create a travelogue, paste six lines (one bad) and add five chapters from the preview, add three more by hand
with place search, drop a pin on the map, split a three-day chapter, find and fix a planted overlap, undo and
redo, reload, play the nine title cards, and check the map inset (trip view on title cards, chapter view,
moving, hiding and undo). Report and screenshots: `docs/phase1-test/`. Result: 20 of 20 checks, with no
browser console errors. The Phase 0 exit test, now 24 checks, adds the inset following the sample's chapters and its photo locations, the hideable side panel, a HEIC upload, and recovery from a broken ffmpeg.

## Phase 2: Media manager

Uploaded photos, videos and voice memos now land in the right chapter by themselves, and the **Media** view
(between Itinerary and Mix) is where the sort gets fixed. A travelogue opens there while anything is unassigned.
Unassigned items (with the Removed bin below them) and the itinerary's chapters sit in two columns that scroll
independently, so you can drag from one to the other without losing your place.

| PRD | Requirement | Where |
| --- | --- | --- |
| MM-1 | Upload files or whole folders: drop them on the Upload tab or pick a folder; subfolders are searched, other files left out | `src/web/uploader.ts` |
| MM-2 | Capture time from EXIF (JPEG, HEIC) and QuickTime/MP4 tags, with the camera's UTC offset when recorded; otherwise the file's modified time, marked uncertain | `src/server/metadata.ts` |
| MM-3 | Each item goes to the chapter whose dates contain its time, read in that chapter's time zone; gaps go to Unassigned; overlaps go to the earlier chapter and are flagged; new items slot in by time. Changing chapter dates, a camera's clock or an item's time moves items in the same undoable step | `src/core/assign.ts` |
| MM-4 | A clock offset per camera, with a live preview of which items would change chapter | `src/core/media-edits.ts`, `src/web/media.ts` |
| MM-5 | Set or shift the time of one or many items (spacing kept), go back to the camera's time, move to a chapter, or drag onto a chapter or an item | same |
| MM-6 | Media grid by chapter: Unassigned first, counts, thumbnails, kind, time, and badges for uncertain times, overlaps, duplicates, copies and distance | `src/web/media.ts` |
| MM-7 | Files already uploaded (same content) are skipped, using a quick sample hash compared in the browser before sending; resumable uploads and Retry processing as before | `src/core/samplehash.ts` |
| MM-8 | Likely duplicates: same content, or same time and size from different sources | `src/core/media-edits.ts` |
| MM-9 | Location from EXIF GPS or QuickTime ISO 6709; set from the chapter's place, by clicking the map, copy/paste between items, or clear | `src/core/contributors.ts` |
| MM-15 | Audio (MP3, M4A, AAC, WAV): duration, recording time, a waveform thumbnail and a playable AAC copy; filed by time | `src/server/media.ts` |
| MM-16 | Travelers are names in the travelogue: choose (or add) whose photos you are uploading, or name the traveler behind a source; their initials on each item, and each person's items on their own | `src/core/contributors.ts`, `src/web/media.ts` |
| MM-17 | Per traveler: items without a capture time or a location, and items that look like reduced copies (stills of 2,048 px or less, 720p video, chat-app file names), with a ready-to-send note asking for the originals | `src/core/contributors.ts` |
| MM-18 | A one-page guide for fellow travelers on sending you their originals, linked from the Upload tab | `src/web/guide-contributors.html` |
| PE-5 (videos) | A video plays in full by default; trim it from the beginning and/or the end in the Media inspector | `src/core/media-edits.ts`, `src/web/media.ts` |
| MM-22 | Remove items to a Removed bin, put them back, delete them for good; delete a whole travelogue | `src/core/remove.ts`, `src/server/deletion.ts` |
| MV-2 | Media map: each located item around its chapter's pin; items far from their chapter flagged | `src/web/media.ts`, `src/web/map.ts` |

**Sources are per person and camera.** Uploads are grouped by whose photos they are (yours, or a traveler's you
pick in the Upload tab's **Whose photos?** menu) and the camera that recorded them (EXIF or QuickTime make and
model), for example "Canon EOS R6" or "Ana · Apple iPhone 14". Clock errors belong to a camera, so a camera an
hour slow can be corrected without moving the same person's phone photos, whose clocks keep network time. Files
with no camera recorded stay in that person's general source ("My uploads", "Ana's photos").

`scripts/phase2-test.ts` scripts the G2 tasks in headless Chromium. It imports the sample with its originals,
then adds:
- your own photos taken after the trip, a screenshot with no camera time, a copy of a sample photo, three photos
  from a camera an hour slow and a phone photo;
- Ana's phone originals (one taken 274 km from its chapter), naming her in **Whose photos?** as they upload;
- Ben's WhatsApp copies, the same way;
- plus a voice memo, a folder with subfolders, and a drag-and-drop.

In the Media view it then places the unassigned items, fixes the slow camera with the preview, finds Ben's
stripped copies and drafts the note, sets locations three ways, and checks everything survives a reload. It also removes, puts back
and deletes items for good, and deletes a whole travelogue. Report and screenshots: `docs/phase2-test/`.
It also trims a video from both ends and resets it, checks the two scrolling columns, the file picker keeping its
selection, and the delete box's place (with no Members tab and no sign-out). Result: 40 of 40 checks, with no
browser console errors.

### Video length

A video plays its whole length by default. To shorten it, select it in the Media view: the inspector's **Play**
field has a preview and **From … to …** seconds. Type the times, or scrub the preview and press **Start here** or
**End here**; **Play the whole video** removes the trim. A trim is stored as the cue's in-point and out-point
(PE-5); with no out-point the video plays to its end, so a clip whose length is only known after processing is
never cut short. The cue profile's old `videoMaxSec` cap is no longer applied.

### Removing and deleting media

- **Remove:** in the Media view, select items and press **Remove** (or Delete/Backspace). They leave the
  travelogue and wait in the **Removed** bin at the bottom of the grid. Removing is an ordinary edit: Undo brings
  them back, and so does restoring a saved version from before.
- **Put back:** select items in the Removed bin and press **Put back**.
- **Delete for good:** select items in the bin and press **Delete for good now**, or leave them: an hourly sweep
  deletes anything that has been in the bin for 30 days (`TRIPALOGUE_PURGE_AFTER_DAYS`). Deleting first takes the
  items out of the travelogue and out of every saved version, records their ids so no edit can bring them back,
  and only then erases the original and derived files.
- **Delete a travelogue:** at the bottom of the Itinerary page, type the travelogue's title and press **Delete this
  travelogue**. Its database rows, operation log, versions, media files and unfinished uploads are all erased.

## Phase 3: Presentation editor

The **Mix** view (between Media and Preview) turns the auto-sorted draft into a cut. It is the player with a timeline
under it and a **Clip** tab beside it; every change is an ordinary edit (undoable, autosaved, in the operation log).

| PRD | Requirement | Where |
| --- | --- | --- |
| PE-1 | Timeline of the whole travelogue: chapter bands with their runtime, title cards, one clip per picture or video as wide as it plays, zoom | `src/web/editor.ts` |
| PE-2 | Play, pause, scrub (click or drag the ruler), **▶ Chapter** (plays it and stops at its end), **▶ From selection** | `src/web/editor.ts` |
| PE-3 | Drag clips to reorder, one or a selection, within a chapter or into another; across chapters it asks: **Change the time to fit** (as in the Media view), or **Keep the time** (the item is held in that chapter by hand until its time changes) | `src/core/presentation.ts` |
| PE-4 | Delete (or **Exclude**) takes clips out of the cut; they wait in the **Excluded** tray, and **Restore** puts them back where they were | same |
| PE-5 | Drag a clip's right edge: an image's duration, or a video's end; or type seconds. Video trims as before (Media inspector, or here) | same |
| PE-6 | With one picture selected, a frame on the stage: drag to move, drag a corner to resize (keeping its shape); it snaps to the centre and thirds of the frame, with guide lines (hold Alt to place freely). Fit, fill and custom in the Clip tab | `src/web/stage-edit.ts` |
| PE-7 | **Reset to defaults** for the selection, or **Reset chapter to defaults** (click a chapter band): durations, trims, placement and fades go back to the cue profile; order and exclusions are kept | `src/core/presentation.ts` |
| PE-8 | Ctrl/Cmd-click and Shift-click select several; set their duration (videos are trimmed to it), placement, inclusion or reset them together | same |
| PE-9 | Runtime in total and per chapter, against a target length (type `5:00`); the bar turns amber past the target | `src/web/editor.ts` |
| AU-1 | Narration and Music lanes under the pictures. Audio items (voice memos, songs) wait in **Audio to place**; drag one onto a lane at any point | `src/core/presentation.ts` |
| AU-2 | Narration anchors to the picture it starts on and moves with it (a lead-in before it is allowed); music anchors to its time in the chapter; switch either way in the Clip tab, keeping where it plays. A clip stops at the end of its chapter | `src/core/timeline.ts` |
| AU-3 | Trim an audio clip's start and end, its volume and fades, whether it ducks the others; per lane volume, mute and solo, including the clip sound inside videos | `src/core/presentation.ts` |
| AU-4 | One mix for preview and (Phase 4) export: clip volume × lane volume × fades × ducking (narration lowers music and clip sound by 12 dB, 0.3 s ramps). The player plays narration and music in step with the pictures. Waveforms on the lanes | `src/core/render-model.ts`, `src/player/player.ts` |

New in the file format (all optional, so older files still load): `targetSec` on the travelogue, `solo` on an audio
lane, `chapterLocked` on a media item, and audio clips' anchors may have a negative offset (a lead-in).

Notes:
- **Excluded vs Removed.** Excluding (Mix view) keeps the item in the travelogue, out of the cut. Removing
  (Media view) takes it out of the travelogue into the Removed bin, to be deleted for good.
- **Preview volume.** Levels above 100% (clip or lane volume up to 200%) play at full volume in the browser
  preview; the export applies them.
- **Music across chapters, cross-fades, Ken Burns and editable fades** are Phase 5.

`scripts/phase3-test.ts` scripts the G3 tasks in headless Chromium. It builds a 12-minute draft (the sample plus
150 generated photos, 30 of them portrait), imports it with a 90 s song and a 6 s voice memo, then: sets a 5:00
target, sets every clip to 2.5 s in one go, excludes a run of 60 clips with Delete, drags a clip's edge, reorders
by drag within a chapter and into the next one (answering "Keep the time"), restores a clip (11:56 → 4:51); moves
three portrait photos on the stage to the thirds and centre and shrinks them; drops the song on the Music lane
under Porto and the memo on a picture, then reorders and trims around it (the memo stays on its picture to the
millisecond); checks the mix (music at 70%, ducked 12 dB under the memo; mute), real playback of the song in step
with the clock, play-this-chapter, reset-chapter, an edit reaching the preview in about 60 ms, a reload, and a
300-item travelogue playing through at 4x with no frames waiting on media. Report and
screenshots: `docs/phase3-test/`. Result: 27 of 27 checks (with the smooth-playback and autoplay checks), with no
browser console errors.

## Phase 4: Video export

**Export MP4** (top right, in every view) saves the travelogue as a video. The local server renders it in the
background from the originals, so you can keep editing, or close the window; TripAlogue says when the file is
ready, in the open view or on the travelogue list next time.

| PRD | Requirement | Where |
| --- | --- | --- |
| VX-1 | MP4, H.264 High and AAC-LC, 30 fps: 720p, 1080p (default) or 4K; plays while it downloads (faststart) | `src/server/render.ts` |
| VX-2 | The export draws what the preview draws: the same order, durations, placement and fades, frame by frame. Both come from the shared plan: export frame *k* is the travelogue at *k* / 30 s, through the same `frameAt()` the player uses | `src/core/export-plan.ts`, `src/core/render-model.ts` |
| VX-3 | Progress, time left and Cancel in the Export dialog; the export renders a snapshot taken when it starts, so editing goes on | `src/web/export.ts`, `src/server/exports.ts` |
| VX-4 | A failure names the item that caused it (a missing original, a format ffmpeg cannot read) with **Show the item**, which opens it in Media | same |
| VX-5 | Export the whole travelogue, one chapter, or a stretch of time (from–to) | `src/core/export-plan.ts` |
| VX-6 | Shapes: landscape 16:9, portrait 9:16 for phones, square 1:1. Pictures are placed for the shape (fit, fill and custom rectangles keep their meaning) | same |
| VX-9 | One stereo AAC track: narration, music and clip sound mixed with the same gains the preview plays (volume, fades, ducking, mute, solo; up to 200%), normalised to -16 LUFS | `src/server/render.ts` (`mixAt()` from the render model) |
| VX-10 | Rendered on this computer from the originals; queued and interrupted exports start again when TripAlogue does; a notice when the file is ready, also after the window was closed | `src/server/exports.ts`, `src/web/export.ts` |

How it renders:
- **Pictures.** Each run of frames (one title card, photo or video) is one ffmpeg pass: the original, turned
  upright, cropped and scaled to the preview's placement, laid on black, faded with the preview's fade times.
  Runs encode in parallel (half the CPU cores, up to 4) and are joined without re-encoding.
- **Title cards** are drawn in the browser by the player's own code at the export's size and sent with the
  request, so they look exactly as in the preview.
- **Sound.** Every source is decoded to 48 kHz PCM at its speed and mixed in JavaScript with `mixAt()` gains every
  10 ms (linear in between, so no clicks), then normalised in two loudnorm passes and encoded at 192 kbit/s.
- **Files** go to `<data>/exports/<travelogue>/<export>/<name>.mp4`, for example
  `Portugal in Ten Days - Sintra - 1080p.mp4`; the dialog shows the path. Download saves a copy; **Delete**
  removes it. Deleting a travelogue deletes its exports.
- **Deterministic:** the same project and settings give the same frames.

`scripts/phase4-test.ts` scripts the G4 tasks in headless Chromium on the sample trip, with a song under Lisbon and
a narration beep on a photo in Porto. It exports the whole travelogue at 1080p while renaming a chapter, downloads
it from the "ready" notice, checks the file (H.264 High level 4.0, AAC-LC, moov first, every frame, -16 LUFS),
compares 5 random frames and a video frame with the preview drawing the same moment (mean difference 2 to 6 of
255, against 78 for a frame 4 s off), checks the narration starts on its picture (2 ms off), exports Lisbon as a
9:16 phone video with the window closed and finds the notice on the travelogue list, cancels an export, and makes
one fail on a missing original and follows **Show the item** to it. On this 2-core test machine the 1:56
travelogue renders in about 97 s (0.83× its length; the target is at most 2×). Report and screenshots:
`docs/phase4-test/`. Result: 16 of 16 checks, with no browser console errors.

## Layout

```text
src/core/     platform-neutral model: schema, validation, migrations, order keys, operations, history, autosave, timeline (with audio clips), render model and audio mix, export plan, telemetry, itinerary, assignment, media edits, presentation edits, contributors, sample hash
src/server/   local server: config, database, media store, the local user, projects and operation log, uploads, media jobs (with HEIC conversion, photo orientation, capture metadata), MP4 exports and the render worker, geo proxy
src/web/      browser app: API client, project session (sync, autosave, lock), resumable uploader, itinerary view, media view, mix view (timeline, clip inspector, stage placement), export dialog, route map, playback inset, UI
src/player/   canvas player (pictures, video and the audio mix) and media pool
src/node/     command line (serve, worker, import, validate, info, new) and file helpers
samples/      hand-written 20-item project (schema v1) and its synthetic media generator
test/         unit and API tests (node:test)
scripts/      build, sample media, exit test, Phase 1, 2, 3 and 4 tests
```

## Not built yet

- Editable transitions and Ken Burns, music across chapters, captions, the inset map in exports and Google Photos
  import are later phases; their data already has a place in the schema.
- HDR video (for example from recent iPhones) is converted to standard range without tone mapping, so its colours
  may look flat in an export.
- A packaged desktop app (its own window and icon). For now it runs as a local server opened in your browser.
