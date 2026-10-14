# Personal library handoff

The reader accepts `#pensieve-launch=` from the private library. The fragment contains an item-scoped endpoint, launch ID and bearer; it is removed from browser history immediately. Never log or export that bearer.

`public/pensieve-sync.js` loads source metadata and the library perspective before starting the existing distiller. Only records tagged `_pensieveLaunch` with a locally stored matching credential are queued for automatic return. Standalone reader runs keep their normal archive behavior. Previously pending legacy outbox records can finish delivery; new standalone records are not automatically exported.

The perspective snapshot is visible in the launch panel. Standalone saved settings are preserved. A library result keeps its perspective and launch ID for translation/detail updates. Deleting a reader record does not delete the PC copy.

GET descriptor /source and POST /start /result use exact Origin + per-launch bearer. The PC must be online to begin a handoff. Completed output waits in IndexedDB while the PC is offline and retries when the reader is open. Refresh never automatically submits the same launch twice. Article jobs additionally persist their existing server job ID and launch metadata for polling recovery. Video generation still runs in the browser; closing its tab can interrupt generation.

No new model call, paid service, dependency, or cloud database is introduced. The existing distiller still incurs its normal provider usage when invoked. API keys and reader access passwords stay in their existing stores.

Source/operations on the owner's PC: `../pensieve-library/reader_launch.py`, `reader-launch-client.js`, and `MAINTENANCE.md`. Keep both deployed copies of `pensieve-sync.js` identical to that shared source. Tests in that folder: `test_reader_launch.py`, `test_reader_outbox.cjs`, `test_reader_flow.cjs` (real mobile DOM and IndexedDB, all external requests mocked; no model charges).
