# Asyar platform feedback — enabling "index-and-launch" extensions

Context: written while building a **Steam Games launcher** extension (`com.geodose.steamgames`,
since renamed `dev.dose.steam`)
against Asyar (SDK `3.1.1` at the time; the extension is on `4.0.0` since 2026-07-06) on Windows.
Status: #1 filed as [issue #448](https://github.com/Xoshbin/asyar/issues/448) and #2 as
[issue #449](https://github.com/Xoshbin/asyar/issues/449) — both accepted 2026-07-07 with
maintainer design guidance and an invited three-PR roadmap (see `../asyar/CLAUDE.md`); #3 fixed by
our PR [#450](https://github.com/Xoshbin/asyar/pull/450), **merged 2026-07-06**; #4+ not yet filed. The extension crawls Steam's `libraryfolders.vdf` /
`appmanifest_*.acf` files to discover installed games, registers each as a dynamic command in the
main search, and launches it via the `steam://run/<appid>` protocol.

This is a common shape — *"index an external app's data, then launch it"* (Steam, Epic, emulators,
project launchers, SSH hosts, etc.). Today that shape is forced entirely through `shell:spawn`,
which is the wrong tool for both halves:

- **Reading** the data files has no file-content API, so we spawn PowerShell (`Get-Content`).
- **Launching** the `steam://` URL is refused by the URL opener, so we spawn PowerShell
  (`Start-Process`).

Both spawns produce a poor UX: a **console window flashes** and a **"a script ran" notification**
pops up, and each new binary triggers a **trust prompt**. The requests below would let this class of
extension run cleanly — ideally with **zero `shell:spawn`**.

File/line references are against `Xoshbin/asyar` around commit `9c2f810` (Feat/file search #444).

---

## Tier 1 — eliminate the need to shell out at all

### 1. Expose a permission-gated file **content read** to Tier-2 extensions

**Problem.** There is no way for an extension to read a file's contents. `fs:read` /
`FileService.read()` is documented as "Future" (unimplemented). `IFilesService` (added/rewritten in
#444) only *searches the index* — it returns paths + metadata, not contents (`files:search` /
`files:status`). So reading `libraryfolders.vdf` / `appmanifest_*.acf` must go through
`shell:spawn` + PowerShell.

**This is now a small ask, because you already built the primitive.** #444 added
`read_text_preview` in `asyar-launcher/src-tauri/src/commands/files.rs` — a bounded Rust file read,
with a rationale that is exactly our use case:

> `read_text_preview` exists because `@tauri-apps/plugin-fs`'s `readFile` is gated by the webview's
> fs capability scope … a Rust command instead, which isn't subject to that scope at all.

But it is **not usable by extensions**, for two reasons:

1. **Host-only.** It is a raw Tauri command (registered in `lib.rs`'s `invoke_handler`, called via
   `invoke('read_text_preview', …)` from built-in frontend code). It is **not** in the
   `asyar:api:*` permission gate — `permissions.rs` only learned `files:search` / `files:status`.
   Sandboxed Tier-2 iframes cannot call raw Tauri commands, so only the built-in "Search Files" view
   can use it.
2. **Scoped to the wrong roots.** `validate_path_allowed` (same file) restricts reads to
   **home / app-data / temp**. Steam lives in `C:\Program Files (x86)`, `D:\`, `B:\` — all outside
   those roots → "Access denied," even if it were exposed.

**Ask.**
- Add a `files:read` (or `fs:read`) permission and route `asyar:api:files:read` →
  `read_text_preview` through the permission gate, so Tier-2 extensions can call it.
- Let the read **scope be declared** per-extension (like `fs:watch`'s `permissionArgs` globs) and
  surfaced in the install-time permission prompt, so a user can consent to reading e.g.
  `C:\Program Files (x86)\Steam\**` — i.e. relax `validate_path_allowed` from a fixed
  home/app-data/temp allowlist to "the fixed roots **or** the extension's declared, consented globs."

Shipping this drops PowerShell from the crawl entirely.

### 2. Let extensions open non-web URL schemes (e.g. `steam://`)

**Problem.** `tauri_plugin_opener.open_url` refuses non-web schemes. Observed at runtime:

```
[invokeSafe] plugin:opener|open_url: Not allowed to open url steam://run/3932890
```

`asyar:api:opener:open` (permission `shell:open-url`, `permissions.rs:137`) and
`browser:openUrl` (`browser/service.rs` → `open_url`) both hit the same allowlist, which is web-only
and baked into Asyar's Tauri capabilities. So an extension cannot hand a registered OS protocol
handler a URL without falling back to `shell:spawn`.

**Ask (preferred).** A **manifest-declared scheme allowlist**, e.g.
`permissionArgs["shell:open-url"]: ["steam"]`, rather than a global hardcode — auditable per
extension and shown in the permission prompt.

**Ask (alternative).** A privileged `application:open(url|path)` capability that reuses Asyar's own
launch path. Note `open_application_path` (`commands/applications.rs`) already `open_path`s freely
with host privileges; a sibling that accepts a (scheme-gated) URL would let extensions launch
protocol handlers exactly the way Asyar launches app entries.

Shipping #1 and #2 together lets this extension drop `shell:spawn` completely — no windows, no run
notifications, no trust prompts.

---

## Tier 2 — if `shell:spawn` stays, make it non-hostile

### 3. Set `CREATE_NO_WINDOW` on extension spawns (Windows)

**Problem / likely bug.** Asyar's *own* internal PowerShell calls set `CREATE_NO_WINDOW` —
`application/service.rs` does this for the app-index scan, with a comment explicitly about not
flashing a console window (issue #411). But the extension `shell:spawn` path (`shell/mod.rs`,
`std::process::Command::new(&program)` with piped stdio) does **not** set `creation_flags`. So every
extension spawn flashes a console window that Asyar's equivalent internal calls suppress.

**Ask.** Set `CREATE_NO_WINDOW` for extension spawns on Windows (or add a `SpawnParams.windowless`
flag). Extension-side `-WindowStyle Hidden` is insufficient — the console is allocated by the
spawner before PowerShell runs.

### 4. A silent / untracked spawn mode

**Problem.** Every extension spawn is promoted to a tracked "run," which is what pops the
"a script ran" notification — even for a 200 ms utility read/launch.

**Precedent already in the codebase.** `docs/reference/silent-agents.md` describes silent agents and
the inline script scheduler **deliberately bypassing** run-tracker promotion so background work
"doesn't pin a kept-Done row every tick."

**Ask.** A `SpawnParams.track: false` (or `silent: true`) that bypasses run promotion + the
notification, for background/utility spawns.

---

## Tier 3 — DX papercuts we tripped over (worth fixing regardless)

### 5. First-class "application entry" contribution
No API lets an extension add a real *Application* to the index with a custom launch target (an exe
path **or** a protocol URL). The only route is writing `.lnk` files into the user's Start Menu
(intrusive, needs `shell:spawn`, needs cleanup, dupes Steam's own shortcuts). An API to contribute
`{ name, icon, launchTarget }` that Asyar launches natively would make "launcher for X" a supported,
first-class pattern.

### 6. Tier-2 `search()` + `actionId` result-action is effectively broken
For installed (Tier-2) extensions, `extensionSearchAggregator` attaches a `navigateToView` action to
every search result, and `searchResultMapper.buildMappedItems` runs that function action **before**
it ever checks `tryExecuteResultAction`. So a result carrying `actionId` opens a blank view instead
of dispatching the action. We had to abandon `search()` for dynamic commands. Fix: when a result has
`actionId`, prefer the action dispatch (or don't attach the view-nav action when `actionId` is set).

### 7. `activate()` is never called for workers
The SDK bridge (`ExtensionBridge`) defines `activateExtensions()` but nothing ever calls it — only
`initialize()` runs. This silently broke our first cut (registration placed in `activate()` never
ran). Either call it on worker ready, or document clearly that worker setup must live in
`initialize()`.

### 8. `enableExtensionSearch` is off by default
`settingsService.svelte.ts` defaults `search.enableExtensionSearch` to `false`, so any
`search()`-based extension contributes **nothing** until the user finds an Advanced-tab toggle — a
silent discoverability trap. Consider prompting on first install of a searchable extension, or
defaulting it on. (Dynamic commands sidestep the gate, but that isn't obvious.)

### 9. The "Create Extension" scaffolder generates invalid IDs
It turned the name "Steam Indexer" into id `com.geodose.steam-indexer`, but the manifest id regex
forbids hyphens (`/^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/`), so the extension can fail discovery. The
scaffolder should sanitize display names into valid IDs.

### 10. Minor: preference type naming
The preferences docs/examples use `type: "text"`, but the validator requires `"textfield"`
(`asyar validate` rejects `"text"`). Align docs/SDK with the validator.

---

## Priority summary

| # | Ask | Impact |
|---|-----|--------|
| 1 | Gated `files:read` for extensions, scope-declarable (wire up + rescope `read_text_preview`) | **Removes shell from the crawl** |
| 2 | Manifest-declared URL-scheme allowlist for `shell:open-url` (or `application:open`) | **Removes shell from launch** |
| 3 | `CREATE_NO_WINDOW` on extension spawns | Removes window flash (fallback path) |
| 4 | Silent/untracked spawn mode | Removes "a script ran" noise (precedent exists) |
| 5 | Native application-entry contribution API | Makes "launcher for X" first-class |
| 6–10 | `search()`+`actionId` fix, worker `activate()`, `enableExtensionSearch`, scaffolder IDs, pref types | DX correctness |

#1 + #2 are the real unlock and map to primitives Asyar already has (`read_text_preview`,
`open_application_path`). #3 + #4 are cheap, high-value fixes with in-repo precedent if extensions
stay on `shell:spawn`.
