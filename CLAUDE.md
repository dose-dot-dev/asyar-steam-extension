# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`dev.dose.steam` (repo: [asyar-steam-extension](https://github.com/dose-dot-dev/asyar-steam-extension)) — a Tier-2 **[Asyar](https://github.com/Xoshbin/asyar)** extension (SDK `4.0.0`, Windows target; requires launcher ≥0.1.1-34). It indexes installed Steam games in the background and registers each as a launchable command in Asyar's main search (`steam://run/<appid>`). No UI/view — everything runs in an always-on **worker** iframe.

## Status (as of 2026-07-08)

Per-game artwork icons are **implemented and verified** against launcher PR [#460](https://github.com/Xoshbin/asyar/pull/460) (`files:glob` + `files:thumbnail`, open, authored by us in `../asyar` branch `feat/files-thumbnail`); the promised manual walkthrough is [reported on the PR](https://github.com/Xoshbin/asyar/pull/460#issuecomment-4917480559). Version 1.1.0. The icon path is a third dual-mode: a startup `files:glob` probe (re-probed on reindex, since consent can arrive late) gates artwork; pre-#460 launchers keep the 🎮 fallback. Icon URLs (`asyar-thumb://`) are re-requested at every registration and **never persisted** — they're mtime-keyed and the launcher cache evicts oldest-first. Asyar #455/#456/#457 are all merged upstream; the dual-mode fallbacks below are for released launchers only. Walkthrough details and the duplicate-rows purge story: `docs/handoff.md`.

## Commands

```bash
npm install            # install deps
npx tsc --noEmit       # typecheck against the real SDK (do this before building)
npx asyar validate     # validate manifest.json — run before builds
npm test               # vitest (watch); npm run test:run for one-shot
npx vitest run src/indexer-core.test.ts   # single test file
npm run build          # vite build -> dist/worker.js
npm run dev            # vite build --watch (rebuild on save)
```

After a build you must **reload the extension** in Asyar (restart Asyar or toggle it in Settings → Extensions) to pick up the new `dist/worker.js`. It's registered as a dev extension in `%APPDATA%\org.asyar.app\dev_extensions.json`, so no `asyar link` is needed.

**Work on the Windows filesystem (`/mnt/c/...`), never a native WSL path** — Asyar runs on Windows and its junctions can't target WSL paths.

## Architecture

Two source files, cleanly split by IO vs. purity:

- **`src/indexer-core.ts`** — the testable core.
  - *Pure parsers* (no IO, unit-tested): `parseLibraryPaths`, `parseAppManifest`, `gamesFromManifests`, `fingerprintGames`, `isToolEntry`.
  - *Shell IO*: `crawlSteam` (one PowerShell call reads `libraryfolders.vdf`, resolves each library's `steamapps/`, dumps every `appmanifest_*.acf`; TS parses back to `{appid, name}`) and `launchGame` (`Start-Process steam://run/<appid>`).
- **`src/worker.ts`** — the `Extension` implementation and worker bootstrap. Loads the cache, registers game commands, and drives reindexing. `executeCommand` routes the `reindex` command and every `game-<appid>` launch.

Flow: **crawl → parse → fingerprint → register**. Each game is published as a **dynamic command** (`commands.replaceDynamicCommands(...)`, worker-only, atomic full-snapshot) with id `game-<appid>`, so it appears in the main search like a built-in command. Reindex runs on an 8h manifest schedule plus a startup refresh (skipped if the cache is <1h old); a `fingerprint` of the game set gates whether commands actually get re-registered. The cache (`StorageService` key `steam-index`: `{games, fingerprint, lastIndexedAt}`) is the source of truth on restart and is re-registered from `initialize()` so games are searchable instantly.

## Non-obvious constraints (why the code looks the way it does)

These are hard-won platform findings — don't "simplify" them away. Full detail in `docs/handoff.md`; the load-bearing ones:

- **File reads are dual-mode (since 2026-07-07).** Launchers with asyar#448 (`files:read`, in review) support bounded reads scoped to the manifest's `permissionArgs["files:read"]` globs — `crawlSteamViaRead` uses them via a raw broker call (`worker.ts` `invokeWire`; the bundled SDK 4.0.0 has no typed proxy yet). Older launchers fall back to `shell:spawn` + PowerShell (`crawlSteam`). The worker probes once at startup (`probeNewCapabilities`) and picks the mode.
- **Everything reuses one `powershell.exe`.** Shell trust is per-`(extension, binary)` and persisted, so the crawl and the launch share the same already-trusted binary to avoid extra trust prompts. `Start-Process steam://…` also exits 0 (no false "run failed") — don't switch to `explorer`/`rundll32`/`cmd`.
- **The opener route is dual-mode too (since 2026-07-07).** Launchers with asyar#449 (declared-scheme allowlist, in review) accept `steam://` through `asyar:api:opener:open` because the manifest declares `permissionArgs["shell:open-url"] = ["steam"]`; `launchGameViaOpener` uses it when the startup probe succeeded. Older launchers' openers still reject non-web schemes — the `Start-Process` PowerShell path (`launchGame`) remains the fallback and must not be removed until the launcher floor rises past #449.
- **`activate()` is never called for workers** — only `initialize()` runs. All setup must live in `initialize()`.
- **Don't use `search()`/`actionId` for launchable results** — Tier-2 search is broken (opens a blank view) and gated behind an off-by-default `enableExtensionSearch` toggle. Dynamic commands sidestep both.
- **PowerShell needs `-Encoding UTF8` + `[Console]::OutputEncoding=UTF8`** or non-ASCII game names (`EA SPORTS™ WRC`) come back as mojibake.

SDK specifics (hit on 3.1.1, still true on 4.0.0): notifications are `INotificationService.send({title, body})` (not `.notify()`); prefs are read via `context.preferences.values.<key>`; manifest `id` cannot contain hyphens; dynamic-command ids must match `[a-zA-Z0-9_-]+` (no `:`). The 3.1.1→4.0.0 migration needed zero code changes (the major bump was the `IFilesService` rewrite, unused here).

## Testing the real crawl

Unit tests cover the pure parsers with real VDF/ACF fixtures. To exercise `crawlSteam` headlessly, write a throwaway `*.test.ts` with a `child_process`-backed fake `IShellService` and delete it after — that's how the full crawl was verified without the GUI.

## Docs

`docs/handoff.md` is the authoritative warm-start (architecture, environment facts, all gotchas). `docs/asyar-feedback.md` / `docs/asyar-issues.md` track the two maintainer asks (`files:read`, URL-scheme allowlist) that would remove PowerShell entirely. `docs/plan-archive.md` is the historical plan.
