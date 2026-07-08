# GitHub issues (top 2 asks) — FILED 2026-07-06

Both issues are now filed on `Xoshbin/asyar` (as `geodose`):

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
