# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`dev.dose.steam` (repo: [asyar-steam-extension](https://github.com/dose-dot-dev/asyar-steam-extension)) — a Tier-2 **[Asyar](https://github.com/Xoshbin/asyar)** extension (SDK `4.0.0`, Windows target; **requires a launcher newer than v0.1.1-34** — i.e. a build of main ≥ `82954f14`, the #460 merge). It indexes installed Steam games in the background and registers each as a launchable command in Asyar's main search (`steam://run/<appid>`), with real Steam artwork icons. No UI/view — everything runs in an always-on **worker** iframe.

## Status (as of 2026-07-08)

Version 2.0.0: **all PowerShell/`shell:spawn` code is removed** — asyar #455/#456/#457/#460 are merged on launcher main, so the crawl uses scoped `files:read`, icons use `files:glob` + `files:thumbnail`, and launching uses the scheme-gated opener; nothing else. The dual-mode fallback era (v1.x) lives in git history and `docs/handoff.md`. Consequences of the floor raise: the extension is inert (fail-closed, cache kept, launch still attempted via opener) on released launchers ≤0.1.1-34, and **Store publication — invited by the maintainer as the first third-party extension (`asyar publish`) — must wait for the first launcher release containing #460.** One startup `files:glob` probe (re-probed on reindex, since consent can arrive late) gates crawl + artwork. Icon URLs (`asyar-thumb://`) are re-requested at every registration and **never persisted** — they're mtime-keyed and the launcher cache evicts oldest-first. The #460 walkthrough is [reported on the PR](https://github.com/Xoshbin/asyar/pull/460#issuecomment-4917480559); walkthrough details and the duplicate-rows purge story: `docs/handoff.md`.

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
  - *Pure parsers* (no IO, unit-tested): `parseLibraryApps`, `parseAppManifest`, `gamesFromManifests`, `fingerprintGames`, `isToolEntry`, `iconGlobPatterns`.
  - *Capability-injected IO*: `crawlSteamViaRead` (reads `libraryfolders.vdf` via an injected `files:read` call, then each `appmanifest_<appid>.acf` the vdf's `apps` blocks list — directly by path, no directory listing) and `launchGameViaOpener` (`steam://run/<appid>` through an injected opener call).
- **`src/worker.ts`** — the `Extension` implementation and worker bootstrap. Loads the cache, registers game commands (with `files:glob`-found, `files:thumbnail`-served icons), and drives reindexing. `executeCommand` routes the `reindex` command and every `game-<appid>` launch.

Flow: **crawl → parse → fingerprint → register**. Each game is published as a **dynamic command** (`commands.replaceDynamicCommands(...)`, worker-only, atomic full-snapshot) with id `game-<appid>`, so it appears in the main search like a built-in command. Reindex runs on an 8h manifest schedule plus a startup refresh (skipped if the cache is <1h old); a `fingerprint` of the game set gates whether commands actually get re-registered. The cache (`StorageService` key `steam-index`: `{games, fingerprint, lastIndexedAt}`) is the source of truth on restart and is re-registered from `initialize()` so games are searchable instantly.

## Non-obvious constraints (why the code looks the way it does)

These are hard-won platform findings — don't "simplify" them away. Full detail in `docs/handoff.md`; the load-bearing ones:

- **All capability calls go through a raw broker invoke** (`worker.ts` `invokeWire`) — the bundled SDK 4.0.0 npm package predates `files:read`/`files:glob`/`files:thumbnail` and the gated opener, so there are no typed proxies yet. Switch to typed SDK calls when a newer asyar-sdk ships them.
- **Everything is fail-closed behind one probe.** A startup `files:glob` of the vdf path proves the launcher has #456/#457/#460 AND that the user consented to the file permissions; on failure the extension keeps its cache, registers it, and re-probes at the next reindex (consent can arrive late). Launching is deliberately NOT gated on the probe — the opener only needs the declared `steam` scheme, so cached games stay launchable while file consent is pending.
- **A vdf read failure mid-crawl must keep the cache** — "consent revoked" and "Steam absent" are indistinguishable from the worker, so `crawlSteamViaRead` throws and `crawl()` maps that to `steamFound: false` (never clobber the game list).
- **`activate()` is never called for workers** — only `initialize()` runs. All setup must live in `initialize()`.
- **Don't use `search()`/`actionId` for launchable results** — Tier-2 search is broken (opens a blank view) and gated behind an off-by-default `enableExtensionSearch` toggle. Dynamic commands sidestep both.
- **Never glob `librarycache/**` in one call** — `files:glob` errors past a 10k-visit budget; `iconGlobPatterns` stays inside one per-appid directory (sha1 layout first, legacy flat layout second).

SDK specifics (hit on 3.1.1, still true on 4.0.0): notifications are `INotificationService.send({title, body})` (not `.notify()`); prefs are read via `context.preferences.values.<key>`; manifest `id` cannot contain hyphens; dynamic-command ids must match `[a-zA-Z0-9_-]+` (no `:`). The 3.1.1→4.0.0 migration needed zero code changes (the major bump was the `IFilesService` rewrite, unused here).

## Testing the real crawl

Unit tests cover the pure parsers and `crawlSteamViaRead` with real VDF/ACF fixtures. To exercise the crawl against the real disk headlessly, write a throwaway `*.test.ts` that passes an `fs.readFile`-backed reader as the injected `ReadTextFile` and delete it after — no launcher needed.

## Docs

`docs/handoff.md` is the authoritative warm-start (architecture, environment facts, all gotchas — including the retired PowerShell-era ones). `docs/asyar-feedback.md` / `docs/asyar-issues.md` track the maintainer asks, all now merged. `docs/plan-archive.md` is the historical plan.
