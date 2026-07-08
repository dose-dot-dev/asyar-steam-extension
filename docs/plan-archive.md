# Plan archive (implementation plan history)

> Copied from the working plan file (`~/.claude/plans/hazy-hatching-aho.md`) for portability.
> **Note:** the last iteration below is the "launch via Asyar's opener" plan, which was
> **tried and reverted** — the opener refuses the `steam://` scheme (see `handoff.md` gotcha
> #2). Launch is back on `shell:spawn` + `powershell Start-Process`. Treat this file as
> history; `handoff.md` reflects the current state.

---

# Plan: Launch Steam games via Asyar's opener (drop the shell-spawn launch)

## Context

The "Steam Games" extension (`com.geodose.steamgames` at the time; now `dev.dose.steam`) is
built and working: it crawls Steam in
the background, registers each installed game as a **dynamic command** (🎮 in the main search), and
currently launches a game by spawning a process (`rundll32 … steam://run/<appid>`) through
`shell:spawn`.

Problem the user raised: launching a game runs "basically a bash command" and requires approving a
binary (`shell:spawn`'s per-binary trust prompt). They want games to launch seamlessly, like other
apps, without that.

Finding from the launcher source: Asyar exposes **`asyar:api:opener:open`** (permission
**`shell:open-url`**) → `openerService.open(url)` → `tauri_plugin_opener` (`open_url`). On Windows
that is a `ShellExecute` on the URL, which handles the `steam://` custom protocol. This path has
**no per-binary trust prompt** (only `shell:spawn` prompts — see `shell/mod.rs` +
`storage/shell.rs` `shell_trusted_binaries`), **no console window**, and returns cleanly (no
"run failed"). It is exactly how Asyar itself launches app entries (`open_application_path`).

Decision (user-selected): **launch via the opener**, keeping games as searchable command entries.
The alternative — writing `.lnk` shortcuts into the Start Menu so games become true "Application"
entries — was rejected: it writes ~31 shortcuts into the user's real Windows Start Menu, still needs
`shell:spawn` to create them, needs uninstall cleanup, and can duplicate Steam's own shortcuts.

Note: `shell:spawn` stays — reading `libraryfolders.vdf` / `appmanifest_*.acf` has no other API
(`fs:read` is unimplemented; `IFilesService` only searches the index). This change only removes the
shell command from the **launch** path.

## How the opener call is routed (verified)

`ExtensionIpcRouter.dispatchApiCall` (`asyar-launcher/src/services/extension/ExtensionIpcRouter.ts`)
maps `asyar:api:opener:open` → `serviceRegistry.opener.open(...)`, building positional args as
`Object.values(payload)`. So `payload = { url }` ⇒ `openerService.open(url)`. The permission gate
(`permissionGate.ts` / Rust `permissions.rs:137`) requires `shell:open-url` in the manifest.

Invocation from the worker uses the SDK broker singleton:
`messageBroker.invoke('opener:open', { url: 'steam://run/<appid>' }, extensionId)` — which posts
`{ type:'asyar:api:opener:open', payload:{ url }, messageId, extensionId }`. (Documented raw
equivalent, if the broker singleton lacks the id: `window.parent.postMessage({ type, payload:{ url },
extensionId, messageId }, '*')`.)

## Changes

- **`manifest.json`** — add `"shell:open-url"` to `permissions` (keep `shell:spawn`,
  `storage:read`, `storage:write`, `notifications:send`).
- **`src/indexer-core.ts`** — remove `launchGame` and its Windows/`xdg-open` shell code (the
  `rundll32`/`capture`-for-launch path). Keep everything used by the crawl (`crawlSteam`, `capture`,
  `powershell`, `ps`, `isWindows`, `joinPath`, parsers, `djb2`).
- **`src/worker.ts`** — replace the shell launch with an opener call:
  - `import { messageBroker } from 'asyar-sdk/contracts';`
  - Capture the extension id (the bootstrap already computes `extensionId`; store it on the instance,
    or read `this.ctx` role — pass the id the same value used in `setExtensionId`).
  - `private async launch(appid): Promise<void>` → `await messageBroker.invoke('opener:open',
    { url: \`steam://run/${appid}\` }, this.extensionId)`, wrapped in try/catch that logs on failure.
  - `executeCommand('game-<appid>')` path is unchanged except it now calls the opener-based `launch`.
  - `this.shell` is still resolved and used for `crawlSteam`; only the launch stops using it.
- **`README.md`** — update the launch description (opener / `shell:open-url`, no trust prompt) and
  the permissions/layout notes.

## Verification

- `npx tsc --noEmit`, `npx asyar validate` (confirm `shell:open-url` accepted), `npx vitest run`
  (9 parser tests unaffected), `npx vite build`.
- Unit/integration of `crawlSteam` is unchanged and still green; launch can't be exercised headless
  (it would open a game), so it's an in-app check.
- **In-app (after reload):** type a game → Enter → the game launches via Steam with **no trust
  prompt, no window flash, no "run failed"** notification. Confirm a second game in a different
  library launches too. (First-ever run still shows the one-time `powershell.exe` trust prompt for
  the *crawl* — that's expected and separate.)

## Risks

- If `tauri_plugin_opener.open_url` on this Windows build refuses a bare custom-protocol URL, fall
  back to `browser`-less alternatives is not needed — `open_url` uses ShellExecute which handles
  `steam://`. If it somehow doesn't, the fallback is the prior `shell:spawn` launch (revert), but
  this is not expected.
- Broker singleton extension-id: if `messageBroker.invoke(..., extensionId)` doesn't carry the id
  through, use the documented raw `postMessage` form with `extensionId` set explicitly.
