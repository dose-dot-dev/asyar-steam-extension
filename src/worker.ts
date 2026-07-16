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
  IFeedbackService,
  ICommandService,
  IFilesService,
  ILogService,
  IStorageService,
} from 'asyar-sdk/contracts';

import manifest from '../manifest.json';
import {
  crawlSteamViaRead,
  iconGlobPatterns,
  launchGameViaOpener,
  steamVdfPath,
  type CrawlResult,
  type SteamGame,
} from './indexer-core';

/** Raw wire invoke on the SDK's message broker (extension id pre-bound). */
type WireInvoke = <T>(command: string, payload?: Record<string, unknown>) => Promise<T>;

const STORE_KEY = 'steam-index';
const GAME_CMD_PREFIX = 'game-';
/** Row icon when no artwork is available (consent pending, missing art). */
const FALLBACK_ICON = '🎮';
/** Source icons are 32×32 and the thumbnail pipeline never upscales; 64
 * leaves headroom for future larger art without re-requesting. */
const ICON_MAX_DIM = 64;
// Skip the startup refresh when the cache was updated this recently —
// avoids a scan every time Asyar restarts.
const STARTUP_REFRESH_MS = 60 * 60 * 1000; // 1 hour

interface CacheShape {
  games: SteamGame[];
  fingerprint: string;
  lastIndexedAt: number;
}

class SteamGamesExtension implements Extension {
  private ctx?: ExtensionContext;
  private log?: ILogService;
  private feedback?: IFeedbackService;
  private storage?: IStorageService;
  private commands?: ICommandService;

  private games: SteamGame[] = [];
  private fingerprint = '';
  private lastIndexedAt = 0;
  private indexing = false;

  /** Typed files proxy (SDK ≥4.1.0): `read` (asyar#456), `glob`/`thumbnail`
   * (asyar#460). */
  private files?: IFilesService;
  /** Raw broker access for the one wire call the SDK still has no typed
   * proxy for: `opener:open` behind the declared-scheme gate (asyar#457). */
  private invokeWire?: WireInvoke;
  /** True once a probe proved the file capabilities are usable — i.e. the
   * launcher is new enough AND the user consented to the file permissions. */
  private capsAvailable = false;

  async initialize(ctx: ExtensionContext): Promise<void> {
    this.ctx = ctx;
    this.log = ctx.getService<ILogService>('log');
    this.feedback = ctx.getService<IFeedbackService>('feedback');
    this.storage = ctx.getService<IStorageService>('storage');
    this.commands = ctx.getService<ICommandService>('commands');

    this.files = ctx.getService<IFilesService>('files');
    const broker = (this.files as unknown as { broker?: { invoke: WireInvoke } })?.broker;
    if (broker) this.invokeWire = broker.invoke.bind(broker) as WireInvoke;
    await this.probeCapabilities();

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

  /** One `files:glob` for the vdf's literal path proves everything this
   * extension needs: `files:glob`/`files:thumbnail` (asyar#460) postdate
   * scoped `files:read` (asyar#456) and the scheme-gated opener (asyar#457),
   * and the call only succeeds once the user consented to the file
   * permissions. A missing Steam root still resolves to `[]` — an array
   * either way. Too-old launchers dispatch the unknown wire type to a
   * missing service method and resolve `undefined`; a pending/denied consent
   * rejects. Reindex re-probes on failure — consent can arrive late. */
  private async probeCapabilities(): Promise<void> {
    if (!this.files) return;
    try {
      const res: unknown = await this.files.glob(
        steamVdfPath({ steamPath: this.steamPathPref() }),
      );
      this.capsAvailable = Array.isArray(res);
    } catch {
      this.capsAvailable = false;
    }
    this.log?.info(
      this.capsAvailable
        ? 'steamgames: file capabilities available — indexing with real game artwork'
        : 'steamgames: file capabilities unavailable (launcher too old, or consent pending) — indexing paused',
    );
  }

  /** Resolve one game's row icon: glob for its client icon (per-appid sha1
   * layout first, legacy flat layout second), then thumbnail the hit. The
   * returned `asyar-thumb://` URL is keyed on source mtime and the cache
   * evicts oldest-first, so URLs are re-requested at every registration and
   * NEVER persisted. Any failure falls back to the generic icon. */
  private async gameIcon(appid: string): Promise<string> {
    if (!this.capsAvailable || !this.files) return FALLBACK_ICON;
    try {
      for (const pattern of iconGlobPatterns(appid, { steamPath: this.steamPathPref() })) {
        // `unknown` + runtime checks stay deliberate: a pre-#460 launcher
        // resolves these wire calls to `undefined` despite the typed proxy.
        const hits: unknown = await this.files.glob(pattern);
        if (!Array.isArray(hits) || hits.length === 0 || typeof hits[0] !== 'string') continue;
        if (hits.length > 1) {
          this.log?.info(`steamgames: ${hits.length} icon candidates for ${appid}, using first`);
        }
        const url: unknown = await this.files.thumbnail(hits[0], { maxDim: ICON_MAX_DIM });
        if (typeof url === 'string' && url) return url;
      }
    } catch (e) {
      this.log?.warn(`steamgames: icon lookup failed for ${appid}: ${String(e)}`);
    }
    return FALLBACK_ICON;
  }

  private async readTextFile(path: string): Promise<string> {
    if (!this.files) throw new Error('files service unavailable');
    const res: unknown = await this.files.read(path);
    if (typeof res !== 'string') throw new Error('files:read not supported by this launcher');
    return res;
  }

  private async openUrl(url: string): Promise<void> {
    if (!this.invokeWire) throw new Error('broker unavailable');
    await this.invokeWire('opener:open', { url });
  }

  /** Launch through the scheme-gated opener. Not gated on the file-caps
   * probe: the opener needs only the declared `steam` scheme, so cached
   * games stay launchable even while file consent is pending. */
  private async launch(appid: string): Promise<void> {
    if (!appid) return;
    try {
      await launchGameViaOpener((u) => this.openUrl(u), appid);
      this.log?.info(`steamgames: launched steam://run/${appid} via opener`);
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
    // Re-probe when the startup probe failed: consent may have been granted
    // since (the launcher withholds the file capabilities until the user
    // approves the permission review), and a reindex is the natural moment
    // to notice.
    if (!this.capsAvailable) await this.probeCapabilities();
    if (!this.capsAvailable) return;
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
      if (this.feedback && (force || (changed && this.notifyPref()))) {
        await this.feedback.sendBackground({
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

  /** Scoped-read crawl. A vdf read failure mid-flight (consent revoked,
   * Steam gone) reports `steamFound: false` so the caller keeps its cache. */
  private async crawl(opts: {
    steamPath?: string;
    hideTools: boolean;
  }): Promise<CrawlResult> {
    try {
      return await crawlSteamViaRead((p) => this.readTextFile(p), opts);
    } catch (e) {
      this.log?.warn(`steamgames: files:read crawl failed (${String(e)}) — keeping cache`);
      return { games: [], fingerprint: '', steamFound: false };
    }
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
