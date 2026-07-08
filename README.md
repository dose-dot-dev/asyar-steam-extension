# Steam

An [Asyar](https://github.com/Xoshbin/asyar) extension that indexes your
installed Steam games in the background and makes them launchable straight from
the Asyar search (via `steam://run/<appid>`).

## What it does

- A hidden **worker** iframe crawls Steam's `steamapps/libraryfolders.vdf` and
  every `appmanifest_*.acf` across all your Steam libraries, building a list of
  installed games.
- Each game is registered as a **dynamic command**, so it shows up in the
  **main search** like any built-in command — type a name, press Enter, the game
  launches through Steam (no view, and no "Extension Search" toggle required).
- Indexing runs automatically on a schedule (default **every 8 hours**) and once
  on startup (only when the cache is stale). Each run is a single PowerShell call;
  a fingerprint of the resulting game set decides whether anything actually
  changed before re-registering.
- A manual **"Reindex Steam Games"** command forces an immediate rescan — handy
  right after installing a new game.

## How it reads and launches (Windows)

Tier 2 extensions are sandboxed (no `@tauri-apps/api`). Both the crawl and the
launch are **dual-mode**: on launchers with the newer capabilities the extension
uses them natively, and on older launchers it falls back to a single trusted
`powershell.exe`:

- **Read:** bounded `files:read` scoped to the manifest's
  `steamapps/libraryfolders.vdf` / `appmanifest_*.acf` globs when the launcher
  supports it ([asyar#448](https://github.com/Xoshbin/asyar/issues/448));
  otherwise one hidden PowerShell call (`Get-Content -Encoding UTF8`) parses
  the same files.
- **Launch:** the Asyar opener with a declared `steam` scheme allowlist when
  supported ([asyar#449](https://github.com/Xoshbin/asyar/issues/449));
  otherwise `Start-Process 'steam://run/<appid>'` (hidden, exits 0, reuses the
  already-trusted `powershell.exe`).

On the PowerShell fallback, Asyar prompts you **once** to trust
`powershell.exe`; after that, reindexing and launching are silent.

Steam location is auto-detected at `C:\Program Files (x86)\Steam`; override it in
the extension's settings if yours is elsewhere.

## Development

```bash
npm install          # install dependencies (asyar-sdk, vite, vitest, …)
npm run build        # production build -> dist/worker.js
npm run dev          # vite build --watch (rebuild on save)
npm test             # vitest unit tests for the parsers
npx asyar validate   # validate manifest.json
```

This project is registered as a dev extension in Asyar's `dev_extensions.json`
(pointing at this folder), so a rebuilt `dist/` is picked up on the next Asyar
reload — no `asyar link` needed. Restart Asyar (or toggle the extension in
Settings → Extensions) to reload after a build.

## Layout

| File | Purpose |
|---|---|
| `manifest.json` | `background.main` worker; `reindex` command with an 8h `schedule`; `shell:spawn` (read + launch) / `storage` / `notifications` permissions; `steamPath` / `hideTools` / `notifyOnReindex` preferences. |
| `src/indexer-core.ts` | Pure parsers (`parseLibraryPaths`, `parseAppManifest`, `gamesFromManifests`, `fingerprintGames`) + the single-spawn `crawlSteam` shell IO. |
| `src/worker.ts` | The `Extension` implementation: registers one dynamic command per game (`replaceDynamicCommands`), routes `executeCommand` (`reindex` + `game-<appid>` launch), scheduled/manual reindex, storage cache, and the worker bootstrap. |
| `src/indexer-core.test.ts` | Vitest unit tests for the parsers using real VDF/ACF fixtures. |

## Settings

| Preference | Default | Effect |
|---|---|---|
| Steam install folder (`steamPath`) | auto | Override the Steam root if not at the default path. |
| Hide Steam tools & redistributables (`hideTools`) | on | Skip Redistributables / Proton / Steam Linux Runtime entries. |
| Notify after a background reindex (`notifyOnReindex`) | off | Notify when a *scheduled* reindex finds a change. Manual reindexes always notify. |
