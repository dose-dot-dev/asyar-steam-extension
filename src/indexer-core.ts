// ───────────────────────────────────────────────────────────────────────────
// indexer-core.ts — Steam library discovery for the Asyar "Steam"
// extension.
//
// Tier 2 extensions run in a sandboxed iframe that CANNOT touch
// `@tauri-apps/api`. Steam's `libraryfolders.vdf` / `appmanifest_*.acf` files
// are read through the launcher's scoped `files:read` (asyar#456), bounded to
// the manifest's `permissionArgs["files:read"]` globs; launching goes through
// the scheme-gated opener (asyar#457). Requires a launcher newer than
// v0.1.1-34 — the earlier `shell:spawn` + PowerShell fallback was removed in
// v2.0.0 (see git history for the dual-mode era).
//
// Concerns are separated:
//   • Pure parsers (`parseLibraryApps`, `parseAppManifest`, `gamesFromManifests`)
//     — no IO, unit-tested.
//   • IO (`crawlSteamViaRead`, `launchGameViaOpener`) — capability calls are
//     injected by the worker, so these stay trivially testable too.
// ───────────────────────────────────────────────────────────────────────────

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

// ── files:read / opener IO ──────────────────────────────────────────────────
//
// Bounded reads scoped to the manifest's `files:read` globs, and
// `steam://run/<appid>` through the scheme-gated opener — no `shell:spawn`
// anywhere. The worker injects the capability calls (raw wire invokes; the
// bundled SDK has no typed proxies for them yet).

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
 * "capability denied (consent pending/revoked)" and "Steam absent" are
 * indistinguishable here, and the caller must keep its cache in both cases.
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
