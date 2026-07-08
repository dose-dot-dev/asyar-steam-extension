// ───────────────────────────────────────────────────────────────────────────
// worker.ts — Tier 2 worker entry for the "Steam" extension.
//
// Each installed game is registered as a **dynamic command** (via
// `commandsService.replaceDynamicCommands`) so it appears in the main search
// like any other command and launches headlessly on Enter — no view, no
// `enableExtensionSearch` toggle required. All of this lives in the always-on
// worker iframe so it survives the launcher window closing.
// ───────────────────────────────────────────────────────────────────────────

import {
  ExtensionContext as WorkerExtensionContext,
  extensionBridge,
} from 'asyar-sdk/worker';
import type {
  CommandExecuteArgs,
  DynamicCommandRegistration,
  Extension,
  ExtensionContext,
  ICommandService,
  IFilesService,
  ILogService,
  INotificationService,
  IShellService,
  IStorageService,
} from 'asyar-sdk/contracts';

import manifest from '../manifest.json';
import {
  crawlSteam,
  crawlSteamViaRead,
  iconGlobPatterns,
  launchGame,
  launchGameViaOpener,
  steamVdfPath,
  type CrawlResult,
  type SteamGame,
} from './indexer-core';

/** Raw wire invoke on the SDK's message broker (extension id pre-bound). */
type WireInvoke = <T>(command: string, payload?: Record<string, unknown>) => Promise<T>;

const STORE_KEY = 'steam-index';
const GAME_CMD_PREFIX = 'game-';
/** Row icon when no artwork is available (older launcher, missing art). */
const FALLBACK_ICON = '🎮';
/** Source icons are 32×32 and the thumbnail pipeline never upscales; 64
 * leaves headroom for future larger art without re-requesting. */
const ICON_MAX_DIM = 64;
// Skip the startup refresh (and its one PowerShell call) when the cache was
// updated this recently — avoids a scan every time Asyar restarts.
const STARTUP_REFRESH_MS = 60 * 60 * 1000; // 1 hour

interface CacheShape {
  games: SteamGame[];
  fingerprint: string;
  lastIndexedAt: number;
}

class SteamGamesExtension implements Extension {
  private ctx?: ExtensionContext;
  private log?: ILogService;
  private notifications?: INotificationService;
  private storage?: IStorageService;
  private shell?: IShellService;
  private commands?: ICommandService;

  private games: SteamGame[] = [];
  private fingerprint = '';
  private lastIndexedAt = 0;
  private indexing = false;

  /** Raw broker access for wire calls the bundled SDK (4.0.0) has no typed
   * proxy for yet: `files:read` (asyar#448), `opener:open` behind the
   * declared-scheme gate (asyar#449), and `files:glob`/`files:thumbnail`
   * (asyar#460). TODO: switch to typed SDK calls once asyar-sdk ships them. */
  private invokeWire?: WireInvoke;
  /** True once a probe proved this launcher supports the scoped `files:read`
   * (and therefore the scheme-gated opener that ships with it). */
  private newCapsAvailable = false;
  /** True once a probe proved `files:glob`/`files:thumbnail` (asyar#460). */
  private thumbsAvailable = false;

  async initialize(ctx: ExtensionContext): Promise<void> {
    this.ctx = ctx;
    this.log = ctx.getService<ILogService>('log');
    this.notifications = ctx.getService<INotificationService>('notifications');
    this.storage = ctx.getService<IStorageService>('storage');
    this.shell = ctx.getService<IShellService>('shell');
    this.commands = ctx.getService<ICommandService>('commands');

    const files = ctx.getService<IFilesService>('files');
    const broker = (files as unknown as { broker?: { invoke: WireInvoke } })?.broker;
    if (broker) this.invokeWire = broker.invoke.bind(broker) as WireInvoke;
    await this.probeNewCapabilities();
    await this.probeThumbnails();

    await this.loadCache();
    // All setup happens here: the SDK bridge calls initialize() but never
    // activate() for a worker, so registration must live in initialize().
    // Register from the cache first so games are searchable immediately on
    // startup (source of truth after a launcher restart).
    await this.registerGameCommands();
    // Refresh only when the cache is empty or stale, so a normal restart with a
    // fresh cache doesn't trigger a scan. The 8h schedule handles the rest.
    if (this.games.length === 0 || Date.now() - this.lastIndexedAt > STARTUP_REFRESH_MS) {
      void this.reindex(false);
    }
  }

  async activate(): Promise<void> {}

  async deactivate(): Promise<void> {}
  onUnload = (): void => {};

  async executeCommand(commandId: string, args?: CommandExecuteArgs): Promise<unknown> {
    if (commandId === 'reindex') {
      // Scheduled ticks carry scheduledTick; a manual run forces a full scan.
      await this.reindex(args?.scheduledTick !== true);
      return undefined;
    }
    if (commandId.startsWith(GAME_CMD_PREFIX)) {
      const appid = commandId.slice(GAME_CMD_PREFIX.length);
      await this.launch(appid);
    }
    return undefined;
  }

  // ── internals ──────────────────────────────────────────────────────────

  /** One `files:read` of the vdf decides which mode this launcher runs in.
   * On pre-#448 launchers the call resolves to a non-string (unknown wire
   * type dispatches to a missing service method) or the opener path would
   * silently no-op — so both new capabilities are gated on this one probe. */
  private async probeNewCapabilities(): Promise<void> {
    if (!this.invokeWire) return;
    try {
      await this.readTextFile(steamVdfPath({ steamPath: this.steamPathPref() }));
      this.newCapsAvailable = true;
      this.log?.info('steamgames: files:read available — using scoped reads + opener launches');
    } catch (e) {
      this.log?.info(
        `steamgames: files:read unavailable (${String(e)}) — using PowerShell paths`,
      );
    }
  }

  /** One `files:glob` for the vdf's literal path proves both asyar#460
   * commands exist (they ship together). A missing Steam root still resolves
   * to `[]` — an array either way. Pre-#460 launchers dispatch the unknown
   * wire type to a missing service method and resolve `undefined`. */
  private async probeThumbnails(): Promise<void> {
    if (!this.invokeWire) return;
    try {
      const res = await this.invokeWire<unknown>('files:glob', {
        pattern: steamVdfPath({ steamPath: this.steamPathPref() }),
        opts: {},
      });
      this.thumbsAvailable = Array.isArray(res);
    } catch {
      this.thumbsAvailable = false;
    }
    this.log?.info(
      this.thumbsAvailable
        ? 'steamgames: files:glob/thumbnail available — using real game artwork'
        : 'steamgames: files:glob/thumbnail unavailable — using fallback icon',
    );
  }

  /** Resolve one game's row icon: glob for its client icon (per-appid sha1
   * layout first, legacy flat layout second), then thumbnail the hit. The
   * returned `asyar-thumb://` URL is keyed on source mtime and the cache
   * evicts oldest-first, so URLs are re-requested at every registration and
   * NEVER persisted. Any failure falls back to the generic icon. */
  private async gameIcon(appid: string): Promise<string> {
    if (!this.thumbsAvailable || !this.invokeWire) return FALLBACK_ICON;
    try {
      for (const pattern of iconGlobPatterns(appid, { steamPath: this.steamPathPref() })) {
        const hits = await this.invokeWire<unknown>('files:glob', { pattern, opts: {} });
        if (!Array.isArray(hits) || hits.length === 0 || typeof hits[0] !== 'string') continue;
        if (hits.length > 1) {
          this.log?.info(`steamgames: ${hits.length} icon candidates for ${appid}, using first`);
        }
        const url = await this.invokeWire<unknown>('files:thumbnail', {
          path: hits[0],
          opts: { maxDim: ICON_MAX_DIM },
        });
        if (typeof url === 'string' && url) return url;
      }
    } catch (e) {
      this.log?.warn(`steamgames: icon lookup failed for ${appid}: ${String(e)}`);
    }
    return FALLBACK_ICON;
  }

  private async readTextFile(path: string): Promise<string> {
    if (!this.invokeWire) throw new Error('broker unavailable');
    const res = await this.invokeWire<unknown>('files:read', { path, opts: {} });
    if (typeof res !== 'string') throw new Error('files:read not supported by this launcher');
    return res;
  }

  private async openUrl(url: string): Promise<void> {
    if (!this.invokeWire) throw new Error('broker unavailable');
    await this.invokeWire('opener:open', { url });
  }

  private async launch(appid: string): Promise<void> {
    if (!appid) return;
    try {
      if (this.newCapsAvailable) {
        await launchGameViaOpener((u) => this.openUrl(u), appid);
        this.log?.info(`steamgames: launched steam://run/${appid} via opener`);
        return;
      }
      if (!this.shell) return;
      await launchGame(this.shell, appid);
      this.log?.info(`steamgames: launched steam://run/${appid}`);
    } catch (e) {
      this.log?.error(`steamgames: launch failed for ${appid}: ${String(e)}`);
    }
  }

  /**
   * Rescan Steam. When `force` is false we first take a cheap fingerprint and
   * bail out if nothing changed since the last index (the scheduled-tick path).
   * Manual runs always force a full re-read.
   */
  private async reindex(force: boolean): Promise<void> {
    if (this.indexing) return;
    // Re-probe when a startup probe failed: consent may have been granted
    // since (the launcher withholds files:read until the user approves the
    // permission review), and a reindex is the natural moment to notice.
    if (!this.newCapsAvailable) await this.probeNewCapabilities();
    if (!this.thumbsAvailable) await this.probeThumbnails();
    if (!this.newCapsAvailable && !this.shell) return;
    this.indexing = true;
    try {
      const opts = { steamPath: this.steamPathPref(), hideTools: this.hideToolsPref() };
      const { games, fingerprint, steamFound } = await this.crawl(opts);
      if (!steamFound) {
        this.log?.warn('steamgames: Steam / libraryfolders.vdf not found — keeping cache');
        return;
      }

      if (!force && fingerprint === this.fingerprint) {
        this.log?.info('steamgames: library unchanged, skipping update');
        return;
      }

      const previous = this.games.length;
      this.games = games;
      this.fingerprint = fingerprint;
      this.lastIndexedAt = Date.now();
      await this.persist();
      await this.registerGameCommands();
      this.log?.info(`steamgames: indexed ${games.length} games`);

      const changed = games.length !== previous;
      if (this.notifications && (force || (changed && this.notifyPref()))) {
        await this.notifications.send({
          title: 'Steam',
          body: `Indexed ${games.length} installed game${games.length === 1 ? '' : 's'}.`,
        });
      }
    } catch (e) {
      this.log?.error(`steamgames: reindex failed: ${String(e)}`);
    } finally {
      this.indexing = false;
    }
  }

  /** Spawn-free crawl when supported, PowerShell otherwise. A files:read
   * failure mid-flight (e.g. consent revoked) degrades to the shell path. */
  private async crawl(opts: {
    steamPath?: string;
    hideTools: boolean;
  }): Promise<CrawlResult> {
    if (this.newCapsAvailable) {
      try {
        return await crawlSteamViaRead((p) => this.readTextFile(p), opts);
      } catch (e) {
        this.log?.warn(`steamgames: files:read crawl failed (${String(e)}), trying PowerShell`);
      }
    }
    if (!this.shell) return { games: [], fingerprint: '', steamFound: false };
    return crawlSteam(this.shell, opts);
  }

  /** Publish the current game list as dynamic commands (atomic full snapshot).
   * Icons resolve concurrently (the launcher caps thumbnail generation
   * host-side); per-game failures degrade to the fallback icon, never block
   * registration. */
  private async registerGameCommands(): Promise<void> {
    if (!this.commands) return;
    const icons = await Promise.all(this.games.map((g) => this.gameIcon(g.appid)));
    const regs: DynamicCommandRegistration[] = this.games.map((g, i) => ({
      id: `${GAME_CMD_PREFIX}${g.appid}`,
      name: g.name,
      description: 'Launch on Steam',
      icon: icons[i],
    }));
    try {
      await this.commands.replaceDynamicCommands(regs);
    } catch (e) {
      this.log?.error(`steamgames: registering game commands failed: ${String(e)}`);
    }
  }

  private async loadCache(): Promise<void> {
    try {
      const raw = await this.storage?.get(STORE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Partial<CacheShape>;
      this.games = Array.isArray(parsed.games) ? parsed.games : [];
      this.fingerprint = typeof parsed.fingerprint === 'string' ? parsed.fingerprint : '';
      this.lastIndexedAt = typeof parsed.lastIndexedAt === 'number' ? parsed.lastIndexedAt : 0;
      this.log?.info(`steamgames: loaded ${this.games.length} cached games`);
    } catch (e) {
      this.log?.warn(`steamgames: cache load failed: ${String(e)}`);
    }
  }

  private async persist(): Promise<void> {
    try {
      const payload: CacheShape = {
        games: this.games,
        fingerprint: this.fingerprint,
        lastIndexedAt: this.lastIndexedAt,
      };
      await this.storage?.set(STORE_KEY, JSON.stringify(payload));
    } catch (e) {
      this.log?.warn(`steamgames: cache save failed: ${String(e)}`);
    }
  }

  private steamPathPref(): string | undefined {
    const v = this.ctx?.preferences.values.steamPath;
    return typeof v === 'string' && v.trim() ? v.trim() : undefined;
  }

  private hideToolsPref(): boolean {
    // Manifest default is true; treat only an explicit `false` as opt-out.
    return this.ctx?.preferences.values.hideTools !== false;
  }

  private notifyPref(): boolean {
    return this.ctx?.preferences.values.notifyOnReindex === true;
  }
}

// ── Bootstrap ───────────────────────────────────────────────────────────────

const extensionId =
  window.location.hostname === 'localhost' ||
  window.location.hostname === 'asyar-extension.localhost'
    ? window.location.pathname.split('/').filter(Boolean)[0] || 'dev.dose.steam'
    : window.location.hostname || 'dev.dose.steam';

const workerContext = new WorkerExtensionContext();
workerContext.setExtensionId(extensionId);

const impl = new SteamGamesExtension();
extensionBridge.registerManifest(manifest as never);
extensionBridge.registerExtensionImplementation(extensionId, impl);
extensionBridge.initializeExtensions();
