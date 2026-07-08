// ───────────────────────────────────────────────────────────────────────────
// indexer-core.ts — Steam library discovery for the Asyar "Steam"
// extension.
//
// Tier 2 extensions run in a sandboxed iframe that CANNOT touch
// `@tauri-apps/api`. The launcher exposes no file-content read service either
// (`fs:read`/FileService.read is unimplemented). The only way to read Steam's
// `libraryfolders.vdf` / `appmanifest_*.acf` files is `IShellService.spawn`.
//
// Asyar's extension `shell:spawn` does NOT pass CREATE_NO_WINDOW, so a
// console-subsystem child (powershell.exe) flashes a window. We mitigate by
// doing the whole crawl in ONE PowerShell call with `-WindowStyle Hidden`, and
// launch through the same already-trusted, hidden powershell.
//
// Concerns are separated:
//   • Pure parsers (`parseLibraryPaths`, `parseAppManifest`, `gamesFromManifests`)
//     — no IO, unit-tested.
//   • Shell-driven IO (`crawlSteam`, `launchGame`) — spawn through the SDK.
// ───────────────────────────────────────────────────────────────────────────

import type { IShellService, ShellChunk } from 'asyar-sdk/contracts';

export interface SteamGame {
  appid: string;
  name: string;
}

export interface CrawlOptions {
  /** Steam root folder override (the folder that contains `steamapps/`). */
  steamPath?: string;
  /** Drop redistributables / runtimes / Proton from the result. */
  hideTools?: boolean;
}

export interface CrawlResult {
  games: SteamGame[];
  /** Signature of the game set; unchanged ⇒ skip re-registration. */
  fingerprint: string;
  /** False when Steam / the vdf could not be found (don't clobber the cache). */
  steamFound: boolean;
}

const DEFAULT_WINDOWS_STEAM_ROOT = 'C:\\Program Files (x86)\\Steam';

/** Delimiter emitted between concatenated appmanifest bodies. */
const ACF_DELIM = '<<<ASYAR-ACF>>>';
/** Marker printed by the crawl script when the vdf is missing. */
const NO_STEAM_MARKER = '<<<ASYAR-NO-STEAM>>>';

/** Non-game appids/names Steam stores as `appmanifest` files. */
const TOOL_NAME_PATTERN =
  /redistributab|proton|steam linux runtime|steamworks common|steamvr|dedicated server/i;

// ── Pure parsers ────────────────────────────────────────────────────────────

/**
 * Extract per-library `{ path, appids }` from `libraryfolders.vdf`. Modern
 * Steam (2021+) writes an `"apps" { "<appid>" "<size>" ... }` block inside
 * every library block — that is what makes a spawn-free crawl possible:
 * knowing the appids up front, each `appmanifest_<appid>.acf` can be read
 * directly by path, no directory listing required.
 */
export function parseLibraryApps(vdf: string): Array<{ path: string; appids: string[] }> {
  const pathRe = /"path"\s+"((?:[^"\\]|\\.)*)"/g;
  const anchors: Array<{ path: string; start: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = pathRe.exec(vdf)) !== null) {
    const unescaped = m[1].replace(/\\\\/g, '\\').replace(/\\"/g, '"');
    if (unescaped) anchors.push({ path: unescaped, start: m.index });
  }
  return anchors.map((anchor, i) => {
    const segment = vdf.slice(anchor.start, anchors[i + 1]?.start ?? vdf.length);
    const appsBlock = /"apps"\s*\{([^}]*)\}/.exec(segment)?.[1] ?? '';
    const appids: string[] = [];
    const idRe = /"(\d+)"\s+"\d+"/g;
    let a: RegExpExecArray | null;
    while ((a = idRe.exec(appsBlock)) !== null) appids.push(a[1]);
    return { path: anchor.path, appids };
  });
}

/**
 * Extract library root folders from `libraryfolders.vdf`. Each library block
 * carries a `"path"  "<root>"` line; Steam stores paths with escaped
 * backslashes (`C:\\Program Files (x86)\\Steam`), which we unescape.
 */
export function parseLibraryPaths(vdf: string): string[] {
  const paths: string[] = [];
  const re = /"path"\s+"((?:[^"\\]|\\.)*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(vdf)) !== null) {
    const unescaped = m[1].replace(/\\\\/g, '\\').replace(/\\"/g, '"');
    if (unescaped) paths.push(unescaped);
  }
  return paths;
}

/**
 * Parse a single `appmanifest_*.acf`. Returns null when the file has no
 * appid or name (corrupt / partial download shells).
 */
export function parseAppManifest(
  acf: string,
): { appid: string; name: string; stateFlags: number } | null {
  const appid = /"appid"\s+"(\d+)"/i.exec(acf)?.[1];
  const name = /"name"\s+"([^"]*)"/i.exec(acf)?.[1]?.trim();
  const stateFlags = Number(/"StateFlags"\s+"(\d+)"/i.exec(acf)?.[1] ?? '0');
  if (!appid || !name) return null;
  return { appid, name, stateFlags };
}

/** True when a manifest entry is a Steam tool rather than a playable game. */
export function isToolEntry(name: string): boolean {
  return TOOL_NAME_PATTERN.test(name);
}

/** Turn raw appmanifest bodies into a deduped, sorted game list. */
export function gamesFromManifests(
  manifests: string[],
  opts: CrawlOptions = {},
): SteamGame[] {
  const byId = new Map<string, string>();
  for (const acf of manifests) {
    const parsed = parseAppManifest(acf);
    if (!parsed) continue;
    if (opts.hideTools && isToolEntry(parsed.name)) continue;
    byId.set(parsed.appid, parsed.name);
  }
  return [...byId.entries()]
    .map(([appid, name]) => ({ appid, name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Signature of the game set — changes on install / uninstall / rename. */
export function fingerprintGames(games: SteamGame[]): string {
  return djb2(games.map((g) => `${g.appid}:${g.name}`).join('|'));
}

// ── Platform / shell plumbing ───────────────────────────────────────────────

function isWindows(): boolean {
  if (typeof navigator === 'undefined') return true; // default target
  return /win/i.test(navigator.userAgent || (navigator as { platform?: string }).platform || '');
}

function joinPath(...parts: string[]): string {
  const sep = isWindows() ? '\\' : '/';
  return parts
    .map((p, i) => (i === 0 ? p.replace(/[\\/]+$/, '') : p.replace(/^[\\/]+|[\\/]+$/g, '')))
    .join(sep);
}

/** The configured (or default) Steam ROOT folder, trailing separators trimmed. */
function steamRoot(opts: CrawlOptions = {}): string {
  return (opts.steamPath?.trim() || DEFAULT_WINDOWS_STEAM_ROOT).replace(/[\\/]+$/, '');
}

/** Single-quote a value for a PowerShell command (doubling embedded quotes). */
function ps(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

const SPAWN_TIMEOUT_MS = 30_000;

/** Spawn a process and resolve with its full stdout once it exits. */
function capture(shell: IShellService, program: string, args: string[]): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let stdout = '';
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    const handle = shell.spawn({ program, args });
    const timer = setTimeout(() => {
      try {
        handle.abort();
      } catch {
        /* ignore */
      }
      finish(() => reject(new Error(`${program} timed out after ${SPAWN_TIMEOUT_MS}ms`)));
    }, SPAWN_TIMEOUT_MS);

    handle.onChunk((c: ShellChunk) => {
      if (c.stream === 'stdout') stdout += c.data;
    });
    handle.onDone(() => finish(() => resolve(stdout)));
    handle.onError((e) =>
      finish(() => reject(new Error(`${program} failed: ${e.code} ${e.message}`))),
    );
  });
}

/**
 * Run a PowerShell script and return its stdout. `-WindowStyle Hidden`
 * suppresses the console window Asyar's spawn would otherwise flash; UTF-8 is
 * forced so non-ASCII game names (™, ©, accents) survive the pipe.
 */
function powershell(shell: IShellService, script: string): Promise<string> {
  const utf8Script = `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ${script}`;
  return capture(shell, 'powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-WindowStyle',
    'Hidden',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    utf8Script,
  ]);
}

// ── High-level steps ────────────────────────────────────────────────────────

/**
 * Crawl every Steam library in a SINGLE PowerShell call: read
 * `libraryfolders.vdf`, resolve each library's `steamapps` folder, and dump
 * every `appmanifest_*.acf`. Parsing back into games happens in TS.
 */
export async function crawlSteam(
  shell: IShellService,
  opts: CrawlOptions = {},
): Promise<CrawlResult> {
  const root = steamRoot(opts);
  const vdfPath = joinPath(root, 'steamapps', 'libraryfolders.vdf');

  // One script does it all: bail with a marker if Steam is absent, otherwise
  // parse library roots from the vdf and stream out each appmanifest body.
  const script = [
    `$ErrorActionPreference='SilentlyContinue'`,
    `$vdf=${ps(vdfPath)}`,
    `if(-not (Test-Path -LiteralPath $vdf)){ '${NO_STEAM_MARKER}'; return }`,
    `$c=Get-Content -Raw -Encoding UTF8 -LiteralPath $vdf`,
    `$roots=[regex]::Matches($c,'"path"\\s+"([^"]+)"') | ForEach-Object { $_.Groups[1].Value -replace '\\\\','\\' }`,
    `$roots=@(${ps(root)}) + $roots | Select-Object -Unique`,
    `$dirs=$roots | ForEach-Object { Join-Path $_ 'steamapps' } | Where-Object { Test-Path -LiteralPath $_ }`,
    `if($dirs){ Get-ChildItem -Path $dirs -Filter 'appmanifest_*.acf' | ForEach-Object { '${ACF_DELIM}'; Get-Content -Raw -Encoding UTF8 -LiteralPath $_.FullName } }`,
  ].join('; ');

  let raw: string;
  try {
    raw = await powershell(shell, script);
  } catch {
    return { games: [], fingerprint: '', steamFound: false };
  }

  if (raw.includes(NO_STEAM_MARKER)) {
    return { games: [], fingerprint: '', steamFound: false };
  }

  const manifests = raw
    .split(ACF_DELIM)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const games = gamesFromManifests(manifests, opts);
  return { games, fingerprint: fingerprintGames(games), steamFound: true };
}

/**
 * Launch a game via Steam's URL protocol.
 *
 * Legacy path: on launchers without the declared-scheme opener
 * (asyar#449), `tauri_plugin_opener.open_url` refuses non-web schemes like
 * `steam://`, so launching goes through `shell:spawn`. We reuse the same
 * `powershell.exe` the crawl already trusted (no new trust prompt), run
 * `Start-Process` (exits 0 — no "run failed"), and inherit `-WindowStyle Hidden`
 * from `powershell()` (no console window).
 */
export async function launchGame(shell: IShellService, appid: string): Promise<void> {
  const url = `steam://run/${appid}`;
  if (isWindows()) {
    await powershell(shell, `Start-Process ${ps(url)}`);
  } else {
    await capture(shell, 'xdg-open', [url]);
  }
}

// ── files:read / opener paths (asyar#448 + #449 launchers) ─────────────────
//
// On launchers with the `files:read` permission and the declared-scheme
// opener, the whole crawl-and-launch cycle needs no `shell:spawn` at all:
// bounded reads scoped to the manifest globs, and `steam://run/<appid>`
// through the gated opener. The worker probes for support at startup and
// falls back to the PowerShell paths above on older launchers.

/** Bounded text read of an absolute path (asyar:api:files:read). */
export type ReadTextFile = (path: string) => Promise<string>;

/** The `libraryfolders.vdf` path for the configured (or default) root. */
export function steamVdfPath(opts: CrawlOptions = {}): string {
  return joinPath(steamRoot(opts), 'steamapps', 'libraryfolders.vdf');
}

/**
 * `files:glob` patterns (asyar#460) locating a game's square client icon,
 * in preference order. Artwork always lives under the Steam ROOT's
 * `appcache\librarycache`, never on the game's library drive.
 *
 * 1. Current per-appid layout: `librarycache/<appid>/<40-hex-sha1>.jpg` —
 *    the only artwork file present for every installed game (survey
 *    2026-07-08: 34/34; `logo.png`/`header.jpg`/`library_600x900.jpg` are
 *    all sparse). 40 `?`s match exactly the hex name and nothing else.
 * 2. Legacy flat layout (pre-2023 installs): `librarycache/<appid>_icon.jpg`.
 *
 * Each pattern starts with an absolute literal prefix as `files:glob`
 * requires, and stays inside one per-appid directory — never glob
 * `librarycache/**` in one call, the command errors past a 10k-visit budget.
 */
export function iconGlobPatterns(appid: string, opts: CrawlOptions = {}): string[] {
  const cacheDir = joinPath(steamRoot(opts), 'appcache', 'librarycache');
  return [
    joinPath(cacheDir, appid, `${'?'.repeat(40)}.jpg`),
    joinPath(cacheDir, `${appid}_icon.jpg`),
  ];
}

/**
 * Spawn-free crawl: read `libraryfolders.vdf`, then read each
 * `appmanifest_<appid>.acf` the vdf's `apps` blocks list — directly by
 * path, so no directory enumeration is needed.
 *
 * A vdf read failure THROWS rather than returning `steamFound: false`:
 * the caller can't tell "capability missing/denied" apart from "Steam
 * absent" here, and the PowerShell fallback probes for Steam properly.
 */
export async function crawlSteamViaRead(
  read: ReadTextFile,
  opts: CrawlOptions = {},
): Promise<CrawlResult> {
  const vdf = await read(steamVdfPath(opts));
  const manifests: string[] = [];
  for (const lib of parseLibraryApps(vdf)) {
    for (const appid of lib.appids) {
      try {
        manifests.push(await read(joinPath(lib.path, 'steamapps', `appmanifest_${appid}.acf`)));
      } catch {
        // Listed in the vdf but the manifest is gone (uninstall race) — skip.
      }
    }
  }
  const games = gamesFromManifests(manifests, opts);
  return { games, fingerprint: fingerprintGames(games), steamFound: true };
}

/** Launch through the scheme-gated opener (requires `shell:open-url` with
 * `permissionArgs["shell:open-url"] = ["steam"]`). */
export async function launchGameViaOpener(
  openUrl: (url: string) => Promise<void>,
  appid: string,
): Promise<void> {
  await openUrl(`steam://run/${appid}`);
}

/** Small, stable string hash for the fingerprint. */
function djb2(input: string): string {
  let h = 5381;
  for (let i = 0; i < input.length; i++) {
    h = ((h << 5) + h + input.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36) + ':' + input.length.toString(36);
}
