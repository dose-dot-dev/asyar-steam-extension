# Handoff — Steam extension for Asyar

Warm-start notes for a fresh session. This captures the current state, architecture, and the
hard-won platform gotchas so you don't have to re-derive them.

- **Extension:** `dev.dose.steam` (Asyar SDK `4.1.0`, Windows target; **since v2.0.0 requires
  launcher ≥ v0.1.1-35**, enforced via `asyarSdk: ^4.1.0` — see the final "SDK 4.1.0" section,
  which supersedes every PowerShell/dual-mode description below. Migrated from SDK 3.1.1 on
  2026-07-06 and to 4.1.0 on 2026-07-09. Renamed from `com.geodose.steamgames` on 2026-07-08).
- **Repo:** <https://github.com/dose-dot-dev/asyar-steam-extension>.
- **Dev location:** `%USERPROFILE%\Desktop\dev\dev.dose.steam` on the Windows filesystem
  (worked on via WSL at the corresponding `/mnt/c/...` path; the folder name must exactly match the id).
- **Registered** as a dev extension in `%APPDATA%\org.asyar.app\dev_extensions.json` →
  `{ "dev.dose.steam": "<windows-path-to-this-folder>" }`.
- **Status:** functional. Games index in the background and are launchable from the main search.
  **Upstream contributions (as `dose-dot-dev`):** PR
  [Xoshbin/asyar#450](https://github.com/Xoshbin/asyar/pull/450) (window-flash fix) was **merged
  2026-07-06** — flash gone in launcher releases after 0.1.1-34. Issues
  [#448](https://github.com/Xoshbin/asyar/issues/448) (`files:read`) and
  [#449](https://github.com/Xoshbin/asyar/issues/449) (URL-scheme allowlist) both got detailed
  maintainer buy-in on 2026-07-07 with an invited three-PR roadmap (generic consent surface →
  `files:read` → scheme gate). **That work happens in the Asyar clone at `../asyar` — see its
  `CLAUDE.md` for the full plan and maintainer design guidance.** Remaining UX noise: the "a script
  ran" notification (feedback #4, not yet filed).

## Rename (done 2026-07-08): `com.geodose.steamgames` → `dev.dose.steam`

The GitHub account was renamed geodose → **dose-dot-dev** (2026-07-07); the id followed on
2026-07-08 (`dev.dose.steam`, folder renamed to match, `dev_extensions.json` key+path updated,
repo `asyar-steam-extension` created). Residual effects of any id rename:

- **Storage is namespaced by extension id** — the old cached `steam-index` is orphaned; harmless,
  the first reindex under the new id rebuilds it.
- **Shell trust is per-`(extension, binary)`** (gotcha #5) — the new id re-prompts once for
  `powershell.exe`.
- References to the old id in the filed GitHub issues/PRs are historical and stay as-is.

## What it does (architecture)

Single Tier-2 **searchable + background** extension; everything runs in the always-on **worker**
iframe.

1. **Crawl** (`src/indexer-core.ts` → `crawlSteam`): one hidden PowerShell call reads
   `libraryfolders.vdf`, resolves each library's `steamapps`, and dumps every `appmanifest_*.acf`.
   TS parses `{ appid, name }` and computes a fingerprint of the game set.
2. **Register** (`src/worker.ts` → `registerGameCommands`): each game becomes a **dynamic command**
   `game-<appid>` via `commands.replaceDynamicCommands(...)`, so it appears in the main search like a
   built-in command (no view, not gated by the "Extension Search" setting).
3. **Launch** (`executeCommand('game-<appid>')` → `launchGame`): spawns the already-trusted
   `powershell.exe` with `Start-Process 'steam://run/<appid>'`.
4. **Schedule:** manifest `reindex` command, `mode: background`, `schedule.intervalSeconds: 28800`
   (8h). Also a startup refresh, gated to skip if the cache is <1h old. Manual **"Reindex Steam
   Games"** command forces a full rescan.
5. **Cache:** `StorageService` key `steam-index` holds `{ games, fingerprint, lastIndexedAt }` so the
   list is available instantly on restart (dynamic commands are re-registered from cache in
   `initialize()`).

## Key files

| File | Role |
|---|---|
| `manifest.json` | `searchable`, `background.main`, permissions `shell:spawn`/`storage:read`/`storage:write`/`notifications:send`, `reindex` command w/ 8h schedule, prefs `steamPath`/`hideTools`/`notifyOnReindex`. |
| `src/indexer-core.ts` | Pure parsers (`parseLibraryPaths`, `parseAppManifest`, `gamesFromManifests`, `fingerprintGames`) + shell IO (`crawlSteam`, `launchGame`) + PowerShell helpers (`powershell`, `capture`, `ps`). |
| `src/worker.ts` | The `Extension` impl: `initialize` (load cache → register → maybe reindex), `executeCommand` (reindex + `game-*` launch), `reindex`, `registerGameCommands`, cache load/persist, prefs. Plus the worker bootstrap. |
| `src/indexer-core.test.ts` | Vitest unit tests for the parsers (real VDF/ACF fixtures). |
| `docs/asyar-feedback.md` | Full prioritized feedback for Asyar maintainers (the platform gaps below). |
| `docs/asyar-issues.md` | The top-2 asks (`files:read`, URL-scheme allowlist) as file-ready GitHub issues. |
| `docs/plan-archive.md` | The evolving implementation plan (the "launch via opener" section was tried and reverted — see gotcha #2). |

## Dev workflow

```bash
cd /mnt/c/.../dev/dev.dose.steam   # always the /mnt/c Windows path, never a native WSL path
npm install
npx tsc --noEmit          # typecheck against the real SDK
npx asyar validate        # manifest validation (run before builds)
npx vitest run            # 9 parser unit tests
npx vite build            # -> dist/worker.js  (npm run dev = vite build --watch)
```

Work on the **Windows filesystem** (`/mnt/c/...`), not a WSL path — Asyar runs on Windows and
`asyar link` uses a Windows junction that can't target a WSL path. After a build, **reload** (restart
Asyar or toggle the extension in Settings → Extensions) to pick up the new `dist/worker.js`.

Fast inner loop: unit-test the parsers with `npx vitest run`. To exercise the real crawl headlessly,
write a throwaway `*.test.ts` that implements a `child_process`-backed fake `IShellService` and calls
`crawlSteam` — that's how the 31-game crawl was verified without the GUI. Delete it after.

## Environment facts (this machine)

- Asyar installed at `C:\Program Files\asyar`, app data at `%APPDATA%\org.asyar.app`.
- **Logs:** `%LOCALAPPDATA%\org.asyar.app\logs\asyar.log` — worker `ILogService` output
  shows up here as `webview:` lines; grep the extension id. This is the fastest way to debug.
- Steam at `C:\Program Files (x86)\Steam`; 3 libraries: `C:\Program Files (x86)\Steam`,
  `D:\SteamLibrary`, `B:\SteamLibrary`. ~31 installed games.
- Windows `node` v22 + `npm` 11 via WSL interop; no `pnpm`/global `asyar` (use `npx asyar`).

## Gotchas / platform findings (the expensive lessons)

1. **No file-content read API.** `fs:read`/`FileService.read` is unimplemented; `IFilesService` only
   searches the index (paths, not contents) — confirmed still true after the #444 file-search commit
   (that only exposes `files:search`/`files:status`; its `read_text_preview` is host-only and
   home/app-data/temp-scoped). So reading Steam's files **must** use `shell:spawn` + PowerShell.
2. **Asyar's opener refuses `steam://`.** We tried launching via `asyar:api:opener:open`
   (`shell:open-url`) — `tauri_plugin_opener.open_url` rejects non-web schemes:
   `plugin:opener|open_url: Not allowed to open url steam://…`. Reverted to `shell:spawn`. **Do not
   re-attempt the opener route** without a maintainer change.
3. **`shell:spawn` flashes a console window.** Asyar's extension spawn (`shell/mod.rs`) doesn't set
   `CREATE_NO_WINDOW` (it does for its *own* PowerShell in `application/service.rs`). `-WindowStyle
   Hidden` helps but doesn't fully suppress the flash. **Fixed by our PR
   [#450](https://github.com/Xoshbin/asyar/pull/450), merged 2026-07-06**; only launcher builds
   ≤0.1.1-34 still flash.
4. **`shell:spawn` runs are surfaced as tracked "runs"** → the "a script ran" notification. No
   extension-side fix; there's a silent-run precedent (`docs/reference/silent-agents.md`) we cite in
   feedback #4.
5. **Shell trust is per-`(extension, binary)` and persisted** (SQLite `shell_trusted_binaries`). So
   launching via the same `powershell.exe` the crawl already trusted needs **no new prompt** — this is
   why launch reuses `powershell.exe` rather than `rundll32`/`explorer`/`cmd` (each of which would be a
   new binary → new prompt). `explorer.exe` also exits 1 → false "run failed"; `rundll32` needs its
   own trust. `powershell Start-Process` exits 0 and is pre-trusted.
6. **`activate()` is never called for workers.** The SDK bridge defines `activateExtensions()` but
   nothing invokes it — only `initialize()` runs. **All setup must live in `initialize()`.** (Our
   first cut registered commands in `activate()` and silently did nothing.)
7. **Tier-2 `search()` + `actionId` is broken** — the aggregator forces a view-navigation action that
   runs before the action dispatch, so results open a blank view. We use **dynamic commands** instead;
   don't go back to `search()` for launchable results.
8. **`enableExtensionSearch` is off by default** — `search()`-based extensions contribute nothing
   until the user flips a Settings → Advanced toggle. Dynamic commands sidestep this entirely.
9. **`application:read` is not useful here** — it's the OS app index (Start Menu `.lnk` + Get-StartApps).
   It has no appid/`steam://`, only lists games that happen to have Start Menu shortcuts, and
   `onApplicationsChanged` fires for *any* app change (over-broad, under-covering). Don't wire it.
10. **`fs:watch` can't watch Steam** — scoped to `$HOME`/`/tmp` (`fs_watcher/matcher.rs`), so it can't
    watch `Program Files`/`D:`/`B:`. No real-time install trigger exists → polling is the only option.

### SDK API specifics that bit us (hit on 3.1.1; all still true on 4.0.0)
- Notifications: **`INotificationService.send({title, body})`**, not `.notify()` (docs/template are wrong).
- Preferences: read via **`context.preferences.values.<key>`**, not `context.preferences.<key>`.
- `ExtensionResult.action` is a **required** field but the worker bridge strips it before postMessage
  (functions can't serialize) — only `actionId`/`actionPayload` survive. (Moot now — we use dynamic
  commands.)
- Dynamic commands: `commands.replaceDynamicCommands(regs)` is **worker-only**, takes the full list
  (atomic snapshot), ids must match `[a-zA-Z0-9_-]+` (no `:`), so `game-<appid>`.
- Manifest **id cannot contain hyphens** (`/^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/`); the built-in
  scaffolder wrongly generated `com.geodose.steam-indexer` from the name — we renamed to
  `com.geodose.steamgames` (since renamed again to `dev.dose.steam`).
- Preference type is **`textfield`**, not `text` (validator rejects `text`); valid launch of the
  `steamPath` pref uses `directory`.
- PowerShell 5.1 needs `-Encoding UTF8` + `[Console]::OutputEncoding=UTF8` or non-ASCII game names
  (e.g. `EA SPORTS™ WRC`) come back as mojibake.

## What's next

- **Nothing is blocked in the extension itself** — it works. The remaining launch UX gaps are
  platform-side, and we're contributing the fixes upstream (all 2026-07-06, as `geodose`):
  1. gated `files:read` for extensions → removes PowerShell from the crawl — **filed as
     [#448](https://github.com/Xoshbin/asyar/issues/448), accepted with design guidance
     2026-07-07**; implementation invited;
  2. URL-scheme allowlist for `shell:open-url` → removes PowerShell from the launch — **filed as
     [#449](https://github.com/Xoshbin/asyar/issues/449), accepted with design guidance
     2026-07-07** (plus the maintainer found an unchecked `browser:openUrl` scheme hole to close in
     the same PR); implementation invited;
  3. window flash → **fixed; our PR [#450](https://github.com/Xoshbin/asyar/pull/450) merged
     2026-07-06**.
  #1 + #2 together make the extension fully native (no shell, no notifications, no prompts). The
  maintainer's roadmap: a generic permission-consent surface PR first, then `files:read` and the
  scheme gate on top — details and plan in `../asyar/CLAUDE.md`.
- The only untouched item is the "a script ran" run-tracker notification (feedback #4 — silent
  spawn mode); file it once the current batch gets traction.
- Toolchains for upstream work are installed: Rust stable in WSL (tests/clippy) and Rust + MSVC
  Build Tools on Windows. **Windows builds must run from native PowerShell** — Windows processes
  spawned via WSL interop cannot traverse junctions ("untrusted mount point"), which breaks both
  pnpm layouts and the launcher's build.rs.

## DONE (2026-07-08): real artwork icons via launcher PR #460

Implemented in v1.1.0 (commit `50b689b`) and verified end-to-end against a dev launcher build
of `feat/files-thumbnail`; walkthrough reported on the PR
(<https://github.com/Xoshbin/asyar/pull/460#issuecomment-4917480559>). All 32 games (34 minus
2 tools) render their real client icon in main search. Consent fail-closed confirmed:
pre-approval the probe is denied → fallback icon; the reindex re-probe picks the capability up
after approval without a restart. Only the per-appid sha1 layout exists on this machine — the
flat-layout pattern resolves to `[]` and falls through cleanly.

**Walkthrough side-finding (launcher bug, GC):** the search index (`search_index.db`,
`search_items`, ids `cmd_<extId>_dyn_<cmdId>`) persists dynamic-command rows and only the owning
extension's next `replaceDynamicCommands` GCs them — the `com.geodose.steamgames` →
`dev.dose.steam` rename orphaned 32 rows, which surfaced as duplicate game entries the moment
icons made the twins distinguishable. Hand-purged 2026-07-08 (launcher stopped, sqlite DELETE on
the old-id rows). The user will file the launcher issue; details in `../asyar` CLAUDE.md
"Known unrelated bug #2".

The rest of this section is the original pickup brief, kept for the API reference.

Supersedes the "What's next" above where they conflict: asyar #455 (consent surface), #456
(`files:read`), and #457 (`shell:open-url` schemes) are ALL merged upstream as of 2026-07-08.
The dual-mode probes below still matter for *released* launchers, but a dev build of launcher
`main` now has everything except thumbnails.

**The task:** launcher PR [#460](https://github.com/Xoshbin/asyar/pull/460) (open, closes #459;
branch `feat/files-thumbnail` in `../asyar`, commit `014cb43e`) adds two commands this extension
should adopt to give every game row its real Steam icon. A manual walkthrough of exactly that was
**promised in the PR thread** — migrate, verify against a dev launcher build of that branch, then
report the result on #460 (the user must approve any GitHub comment first; never include the real
name or `C:\Users\...` paths).

**The new API** (wire names, via the same raw-broker `invokeWire` pattern `files:read` already
uses in `worker.ts` — bundled SDK 4.0.0 has no typed proxy for them):

- `files:glob` `{ pattern, opts: { maxResults? } }` → `string[]` — scoped enumeration under the
  manifest's `files:read` globs. The REQUESTED pattern must start with an absolute literal prefix
  (the declared manifest globs may stay unanchored). Sorted, ≤256 results, symlinks skipped,
  missing root → `[]`, out-of-scope pattern → rejects.
- `files:thumbnail` `{ path, opts: { maxDim? } }` → `string | null` — `asyar-thumb://` URL (or
  `http://asyar-thumb.localhost/...` on Windows), image files only (identical on every OS),
  `maxDim` clamped 16–512. The URL works directly as a dynamic command `icon` — the launcher
  frontend renders image-URL icons on search rows with no changes.

**Migration sketch:**

1. Manifest: add `"**/appcache/librarycache/**"` to `permissionArgs["files:read"]` (artwork
   lives under the Steam ROOT, not the library drives). Bump version; users re-consent on the
   changed permission args.
2. Per game, enumerate the sha1-named square icon (the ONLY artwork present for 100% of the 34
   games surveyed on this machine; `logo.png`/`library_600x900.jpg`/`header.jpg` are all sparse):
   `files:glob` with `<steamRoot>/appcache/librarycache/<appid>/` + `'?'.repeat(40)` + `.jpg`,
   then `files:thumbnail(hits[0], { maxDim: 64 })` (source icons are 32×32; the pipeline never
   upscales). Re-request URLs on every registration — the thumb cache key includes mtime and the
   cache evicts oldest-first, so never persist URLs in the storage cache.
3. Probe: gate on a startup `files:glob` succeeding (unknown command on older launchers →
   rejection), alongside the existing `probeNewCapabilities`; iconless registration is the
   fallback. Multiple hex hits per dir are possible — hits are sorted; picking `hits[0]` is
   deterministic, but consider preferring the newest or logging when >1.
4. Walkthrough (Windows PowerShell, installed Asyar quit first): in `../asyar` check out
   `feat/files-thumbnail`, `pnpm tauri dev` from `asyar-launcher/`; rebuild this extension
   (`npm run build`), toggle it in Settings → Extensions, confirm artwork rows in main search,
   consent chips show the new glob, and out-of-scope probes still fail closed. Screenshot-worthy
   result → report on #460.

**Watch out:** the 40-hex layout is Steam's current per-appid `librarycache/<appid>/` scheme;
older installs kept flat `librarycache/<appid>_icon.jpg` files. If a machine shows the flat
layout, a second glob pattern covers it — mention the finding on #460 rather than silently
handling only one. Also `files:glob` errors past a 10k-entry visit budget: always glob the
per-appid directory, never `librarycache/**` in one call.

## DONE (2026-07-08, after the #460 merge): PowerShell fully removed — v2.0.0

With asyar #455 (consent surface), #456 (`files:read`), #457 (opener scheme gate), and #460
(`files:glob`/`files:thumbnail`) ALL merged to launcher main (`82954f14`), the dual-mode era is
over: v2.0.0 deletes `crawlSteam`, `launchGame`, the `powershell`/`capture`/`ps` helpers,
`parseLibraryPaths` (only the PowerShell path used it), the `IShellService` wiring, and the
`shell:spawn` manifest permission. **This supersedes gotchas #1–#5 and the dual-mode
descriptions above** — they document why the fallback existed and stay for history; the UTF-8
mojibake lesson (SDK-specifics list) is likewise PowerShell-era only.

What remains, and the shape it has now:

- One probe (`probeCapabilities`): a startup `files:glob` of the vdf path proves the launcher
  floor AND file consent in one call; failure = fail-closed (cache kept and registered, crawl
  paused) with a re-probe at every reindex, because consent can arrive late.
- Launch is NOT gated on that probe — the opener needs only the declared `steam` scheme, so
  cached games remain launchable while file consent is pending. A too-old launcher's opener
  rejects `steam://`; the error is logged, nothing else happens.
- A mid-crawl vdf read failure still throws out of `crawlSteamViaRead` and is mapped to
  `steamFound: false` (keep the cache) — "consent revoked" and "Steam gone" are
  indistinguishable from the worker.
- All capability calls still go through the raw `invokeWire` broker: the *published*
  asyar-sdk 4.0.0 predates every one of these APIs (launcher main's SDK source has typed
  `files` proxies now, but no new npm release yet). Switch when one ships.

**Launcher floor / Store consequence (as written 2026-07-08, superseded next section):** the
newest *released* launcher (v0.1.1-34, 2026-07-06) predates all four PRs, so v2.0.0 only works
on a dev build of main ≥ `82954f14`. The maintainer-invited Store publication (`asyar publish`,
first third-party extension) must wait for the first launcher release containing #460. There is
no manifest field for a launcher version floor — the SDK pin (`^4.0.0`) does not express it —
so a too-old launcher loads the extension and it simply stays inert (plus the log line "file
capabilities unavailable").

## SDK 4.1.0 / launcher v0.1.1-35 (2026-07-09): floor expressible, publication unblocked

Launcher **v0.1.1-35** shipped 2026-07-09 together with **asyar-sdk 4.1.0** on npm — the first
release containing #455/#456/#457/#460 (and our #464 sync fix). Changes made the same day:

- **Dep bumped to `asyar-sdk@^4.1.0`** and the three `files:*` calls migrated from `invokeWire`
  to the typed `IFilesService` proxy (`read`/`glob`/`thumbnail` — new in 4.1.0). Only
  `opener:open` remains on the raw broker (no typed opener proxy yet). The runtime `unknown`
  checks on files results were kept deliberately: a pre-#460 launcher resolves those wire types
  to `undefined` no matter what the proxy types claim.
- **The launcher floor is now expressible:** the manifest declares `asyarSdk: ^4.1.0`, and since
  the launcher embeds its workspace SDK version (`SUPPORTED_SDK_VERSION` = 4.1.0 in v0.1.1-35,
  4.0.0 in v0.1.1-34), the compat gate in `discovery.rs` now rejects the extension on pre-#460
  launchers outright instead of loading it inert. The probe still covers the consent-pending
  case on new-enough launchers.
- **Verified against the installed v0.1.1-35** (2026-07-09): worker initialized, probe passed,
  full crawl via typed `files.read` (fingerprint unchanged → cache correctly kept), 32/32 games
  re-registered with real `asyar-thumb://` icons.
- Store publication is unblocked; `asyar publish` (4.1.0 CLI, `--dry-run` supported) is the
  next step.
