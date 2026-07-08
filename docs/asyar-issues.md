# GitHub issues — maintainer asks

Issues 1–2 filed on `Xoshbin/asyar` 2026-07-06 (as `geodose`); Issue 3 filed 2026-07-08 (as `dose-dot-dev`):

- Issue 3 → [#459](https://github.com/Xoshbin/asyar/issues/459)

- Issue 1 → [#448](https://github.com/Xoshbin/asyar/issues/448)
- Issue 2 → [#449](https://github.com/Xoshbin/asyar/issues/449)

The as-filed text added a footer pinning references to commit `c73abcbc` (chore(sdk):
release 4.0.0 #446) and an offer to implement once the permission shape is agreed.
File/line references below re-verified at that commit (originally written against
`9c2f810`, Feat/file search #444).

---

## Issue 1

**Title:** Expose a permission-gated file **content read** to Tier-2 extensions (`files:read`)

**Labels:** enhancement, sdk, extensions

**Body:**

### Problem

Tier-2 extensions have no way to read a file's **contents**.

- `fs:read` / `FileService.read()` is documented as "Future" (unimplemented).
- `IFilesService` (rewritten in #444) only searches the **index** — it returns paths + metadata via
  `files:search` / `files:status`, never file contents.

So any extension that needs to parse a local file (config, manifest, save data) must shell out via
`shell:spawn` (e.g. PowerShell `Get-Content`), which flashes a console window and raises a per-binary
trust prompt. Example use case: a Steam-games launcher reading
`steamapps/libraryfolders.vdf` and `appmanifest_*.acf` to enumerate installed games.

### The primitive already exists

#444 added `read_text_preview` in `asyar-launcher/src-tauri/src/commands/files.rs` — a bounded Rust
file read — with a rationale that matches this request exactly:

> `read_text_preview` exists because `@tauri-apps/plugin-fs`'s `readFile` is gated by the webview's
> fs capability scope … a Rust command instead, which isn't subject to that scope at all.

It just isn't reachable by extensions, for two reasons:

1. **Host-only.** It's a raw Tauri command (registered in `lib.rs`'s `invoke_handler`, invoked as
   `invoke('read_text_preview', …)` by built-in frontend code). It is **not** in the `asyar:api:*`
   permission gate — `permissions.rs` only added `files:search` / `files:status`. Sandboxed Tier-2
   iframes can't call raw Tauri commands.
2. **Scope.** `validate_path_allowed` (same file) restricts reads to **home / app-data / temp**. Many
   targets (e.g. `C:\Program Files (x86)\Steam`, other drives) are outside those roots and would be
   denied even if the command were exposed.

### Proposed solution

1. Add a `files:read` (or `fs:read`) permission and route `asyar:api:files:read` →
   `read_text_preview` through the permission gate so Tier-2 extensions can call it.
2. Make the read **scope declarable per extension** — the same pattern `fs:watch` already uses with
   `permissionArgs` globs — and show those globs in the install-time permission prompt. Concretely:
   relax `validate_path_allowed` from a fixed home/app-data/temp allowlist to "the fixed roots **or**
   the calling extension's declared, user-consented globs."

Keep the existing bounded-read safety (byte cap, lossy UTF-8, absolute-path + `..` normalization).

### Acceptance criteria

- [ ] A Tier-2 extension declaring `files:read` (with a scoped glob) can read a file's text via the
      SDK, subject to the permission gate on both layers.
- [ ] Reads outside the fixed roots **and** outside the extension's declared globs are denied.
- [ ] The declared read scope is shown to the user at install/enable time.

---

## Issue 2

**Title:** Let extensions open non-web URL schemes (e.g. `steam://`) via a declared scheme allowlist

**Labels:** enhancement, sdk, extensions

**Body:**

### Problem

Extensions can't open a registered OS protocol handler (custom URL scheme) without `shell:spawn`.
`tauri_plugin_opener.open_url` refuses non-web schemes. Observed at runtime when opening
`steam://run/<appid>` via `asyar:api:opener:open`:

```
[invokeSafe] plugin:opener|open_url: Not allowed to open url steam://run/3932890
```

Both extension-facing paths hit the same web-only allowlist (baked into Asyar's Tauri capabilities):

- `asyar:api:opener:open` → permission `shell:open-url` (`permissions.rs:137`)
- `asyar:api:browser:openUrl` → `browser/service.rs` → `open_url`

So launching anything by protocol URL (Steam/Epic games, `vscode://`, `obsidian://`, `zoommtg://`,
etc.) forces a `shell:spawn` fallback — console-window flash, "a script ran" run-tracker
notification, and a per-binary trust prompt.

### Proposed solution (preferred)

A **manifest-declared URL-scheme allowlist**, mirroring the `fs:watch` `permissionArgs` pattern:

```json
{
  "permissions": ["shell:open-url"],
  "permissionArgs": { "shell:open-url": ["steam"] }
}
```

The opener command checks the requested URL's scheme against the calling extension's declared list
before handing it to `open_url`; the declared schemes are shown in the permission prompt. This is
per-extension and auditable, versus globally whitelisting `steam://`.

### Alternative

A privileged `application:open(url|path)` capability that reuses Asyar's own launch path.
`open_application_path` (`commands/applications.rs`) already `open_path`s freely with host
privileges; a sibling that accepts a **scheme-gated** URL would let extensions launch protocol
handlers the same way Asyar launches app entries.

### Acceptance criteria

- [ ] An extension declaring `shell:open-url` with `permissionArgs["shell:open-url"] = ["steam"]`
      can open `steam://…`; a scheme not in its list is rejected.
- [ ] The allowed schemes are surfaced in the install/enable permission prompt.
- [ ] No `shell:spawn` is required to launch a declared-scheme URL.

### Impact

Combined with a `files:read` API (separate issue), this removes `shell:spawn` entirely from the
"index an app's files, then launch it by URL" extension pattern — no console windows, no run
notifications, no trust prompts.

---

## Issue 3 — filed as [#459](https://github.com/Xoshbin/asyar/issues/459) (2026-07-08)

**Title:** Expose permission-gated file thumbnails to Tier-2 extensions (`files:thumbnail`) so dynamic commands can show real artwork

**Labels:** enhancement, sdk, extensions

**Body:**

### Problem

Dynamic commands can only show built-in icons (`icon:*`) or emoji. Launcher-indexed applications
show their real icons (extracted host-side into `icon_cache/`, served via `asyar-icon://`), so any
extension that registers *launchable external items* as dynamic commands — the pattern #448/#449
enable — renders visibly second-class next to them.

Concrete case: a Steam extension registers each installed game as a dynamic command. Steam already
keeps per-game square icons on disk (`appcache\librarycache\<appid>\<sha1>.jpg`, 32×32, 1–2.5 KB,
present for 100% of installed games on the test machine), but the extension has no sanctioned way to
turn those files into row icons.

### The primitive already exists

The thumbnail module added for file-search previews is a complete, generic image→icon pipeline:

- `thumbnail/mod.rs` — `get_or_generate(state, cache_dir, path, max_dim)`: content-addressed
  (path+mtime+size+dim) PNG cache with concurrency capping and byte-cap eviction
  (`cache.rs::evict_if_over_cap`), downscaling via the `image` crate.
- `uri_schemes.rs` — serves `thumbnail_cache/` under `asyar-thumb://` with the same traversal
  guards as `asyar-icon://`.
- The window CSP already allows `img-src … asyar-thumb: http://asyar-thumb.localhost`.
- `LauncherListRow.svelte` already renders any image-URL icon string on a search row
  (`iconUtils.isIconImage`), and dynamic-command registration passes `icon` through untouched
  (`commands/dynamic_commands.rs`) — so a thumbnail URL used as a dynamic command's `icon` renders
  today with **zero frontend changes**.

It just isn't reachable by extensions: `get_file_thumbnail` (`thumbnail/commands.rs`) is a raw
host-only Tauri command (called from `built-in-features/file-search/DefaultView.svelte` via
`invokeSafe`), is not in the `asyar:api:*` permission gate, and — being host-only — performs **no
path-scope validation at all**, so it can't simply be opened up as-is.

### Proposed solution

Route `asyar:api:files:thumbnail` → `get_or_generate` through the permission gate, scoped exactly
like `files:read` (#448 / PR #456):

1. **Permission:** gate on `files:read` itself — a thumbnail is strictly less information than the
   byte read that permission already grants, so no new consent surface is needed; the declared
   globs shown at install/enable (#455) cover both. (A separate `files:thumbnail` permission works
   too if the distinction is preferred in the prompt.)
2. **Scope:** the caller's declared `permissionArgs["files:read"]` globs ONLY, plus the same hard
   deny-list, re-checked inside the Rust command (the two-layer pattern from PR #456).
3. **API:** `asyar:api:files:thumbnail { path, maxDim? }` → existing pipeline → returns the same
   `asyar-thumb://` / `http://asyar-thumb.localhost/` URL the host frontend uses (or `null` when no
   strategy exists). SDK: `IFilesService.thumbnail(path, opts?)` beside `search`/`status`/`read`.

The extension then sets that URL as the dynamic command's `icon` and registers as usual.

### Alternatives considered

- **Base64/binary mode on `files:read` + `data:` URIs** — works, but ships image bytes through the
  IPC bridge and persists them into the search index per command, and every extension reinvents
  resizing/caching the thumbnail module already does well.
- **Extensions writing into `icon_cache/`** — that directory is launcher-owned; no.

### Acceptance criteria

- [ ] An extension declaring `files:read` globs covering `**/appcache/librarycache/**` can request a
      thumbnail for a matching file and receive an `asyar-thumb://` URL; paths outside its globs or
      on the deny-list are rejected.
- [ ] That URL, set as a dynamic command `icon`, renders in the main search row.
- [ ] No `shell:spawn` involved at any point.

### Impact

Completes the visual parity story for the #448/#449 extension pattern: indexed external items
(games, projects, documents…) get real artwork through the exact cache/scheme/CSP/render paths the
launcher already uses for its own previews, at the cost of one gated command route.

### Post-filing addendum (2026-07-08, not yet posted to the thread)

Coverage survey of `librarycache` artwork across all 34 installed games on the dev machine, done
after filing: the **only** file present for 100% of games is the sha1-named square icon
(`<appid>/<40-hex>.jpg`). Fixed-name art is sparse — `logo.png` 17/34, `library_600x900.jpg` 15/34,
`header.jpg` 8/34. Since extensions cannot enumerate directories, an exact-path-only
`files:thumbnail` cannot reach the one file that always exists.

**The PR must therefore include scoped enumeration**, one of:

- `path` accepts a glob resolved within the declared `files:read` scope, deterministic pick
  (a 40-`?` glob matches the hex name precisely); or
- a `files:glob` sibling command returning scope-matching paths.

Alternatives evaluated and rejected: raw extension writes to `icon_cache/` (flat launcher-owned
namespace → collision/spoofing risk, would be the platform's first extension *write* capability, no
eviction or uninstall cleanup) and a mediated `icons:ingest` (duplicates `get_or_generate` into an
eviction-less directory). Thumbnail-cache eviction is a non-issue for this use
(`CACHE_CAP_BYTES` = 300 MB, oldest-first sweep, URLs re-requested on every registration).
