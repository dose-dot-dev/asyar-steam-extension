import { describe, it, expect } from 'vitest';
import {
  parseLibraryPaths,
  parseLibraryApps,
  parseAppManifest,
  isToolEntry,
  gamesFromManifests,
  crawlSteamViaRead,
  iconGlobPatterns,
  launchGameViaOpener,
  steamVdfPath,
} from './indexer-core';

// Fixtures captured verbatim from this machine's Steam install. String.raw
// keeps the doubled backslashes exactly as Steam writes them to disk.
const LIBRARYFOLDERS_VDF = String.raw`"libraryfolders"
{
	"0"
	{
		"path"		"C:\\Program Files (x86)\\Steam"
		"label"		""
		"apps"
		{
			"228980"		"561986193"
			"1091500"		"91231172278"
		}
	}
	"1"
	{
		"path"		"D:\\SteamLibrary"
		"label"		""
		"apps"
		{
			"730"		"68462320205"
		}
	}
	"2"
	{
		"path"		"B:\\SteamLibrary"
		"label"		""
		"apps"
		{
			"690790"		"117594033997"
		}
	}
}`;

const CYBERPUNK_ACF = String.raw`"AppState"
{
	"appid"		"1091500"
	"universe"		"1"
	"LauncherPath"		"C:\\Program Files (x86)\\Steam\\steam.exe"
	"name"		"Cyberpunk 2077"
	"StateFlags"		"4"
	"installdir"		"Cyberpunk 2077"
}`;

const CS2_ACF = String.raw`"AppState"
{
	"appid"		"730"
	"name"		"Counter-Strike 2"
	"StateFlags"		"4"
	"installdir"		"Counter-Strike Global Offensive"
}`;

const REDIST_ACF = String.raw`"AppState"
{
	"appid"		"228980"
	"name"		"Steamworks Common Redistributables"
	"StateFlags"		"4"
}`;

describe('parseLibraryPaths', () => {
  it('extracts and unescapes all library roots', () => {
    expect(parseLibraryPaths(LIBRARYFOLDERS_VDF)).toEqual([
      'C:\\Program Files (x86)\\Steam',
      'D:\\SteamLibrary',
      'B:\\SteamLibrary',
    ]);
  });

  it('returns an empty array for junk input', () => {
    expect(parseLibraryPaths('not a vdf')).toEqual([]);
  });
});

describe('parseAppManifest', () => {
  it('reads appid, name and StateFlags', () => {
    expect(parseAppManifest(CYBERPUNK_ACF)).toEqual({
      appid: '1091500',
      name: 'Cyberpunk 2077',
      stateFlags: 4,
    });
  });

  it('returns null when appid or name is missing', () => {
    expect(parseAppManifest('"AppState" { "name" "x" }')).toBeNull();
    expect(parseAppManifest('garbage')).toBeNull();
  });
});

describe('isToolEntry', () => {
  it('flags redistributables and runtimes', () => {
    expect(isToolEntry('Steamworks Common Redistributables')).toBe(true);
    expect(isToolEntry('Proton 9.0')).toBe(true);
    expect(isToolEntry('Steam Linux Runtime 3.0 (sniper)')).toBe(true);
  });

  it('does not flag real games', () => {
    expect(isToolEntry('Cyberpunk 2077')).toBe(false);
    expect(isToolEntry('Counter-Strike 2')).toBe(false);
  });
});

describe('gamesFromManifests', () => {
  it('parses, sorts and drops tools when hideTools is set', () => {
    const games = gamesFromManifests([CYBERPUNK_ACF, CS2_ACF, REDIST_ACF], { hideTools: true });
    expect(games).toEqual([
      { appid: '730', name: 'Counter-Strike 2' },
      { appid: '1091500', name: 'Cyberpunk 2077' },
    ]);
  });

  it('keeps tools when hideTools is false', () => {
    const games = gamesFromManifests([CYBERPUNK_ACF, REDIST_ACF], { hideTools: false });
    expect(games.map((g) => g.appid).sort()).toEqual(['1091500', '228980']);
  });

  it('dedupes by appid', () => {
    const games = gamesFromManifests([CS2_ACF, CS2_ACF]);
    expect(games).toEqual([{ appid: '730', name: 'Counter-Strike 2' }]);
  });
});

describe('parseLibraryApps', () => {
  it('pairs each library root with the appids in its apps block', () => {
    expect(parseLibraryApps(LIBRARYFOLDERS_VDF)).toEqual([
      { path: 'C:\\Program Files (x86)\\Steam', appids: ['228980', '1091500'] },
      { path: 'D:\\SteamLibrary', appids: ['730'] },
      { path: 'B:\\SteamLibrary', appids: ['690790'] },
    ]);
  });

  it('returns empty appids for a library without an apps block', () => {
    const vdf = String.raw`"libraryfolders" { "0" { "path" "C:\\Steam" "label" "" } }`;
    expect(parseLibraryApps(vdf)).toEqual([{ path: 'C:\\Steam', appids: [] }]);
  });

  it('returns an empty array for junk input', () => {
    expect(parseLibraryApps('not a vdf')).toEqual([]);
  });
});

describe('crawlSteamViaRead', () => {
  // joinPath picks its separator from the runtime UA, which in Node-based
  // vitest is neither the Windows webview nor stable across Node versions —
  // normalize to backslashes so the fixtures match on any host.
  const norm = (p: string): string => p.replace(/\//g, '\\');
  const FILES: Record<string, string> = {
    'C:\\Program Files (x86)\\Steam\\steamapps\\libraryfolders.vdf': LIBRARYFOLDERS_VDF,
    'C:\\Program Files (x86)\\Steam\\steamapps\\appmanifest_1091500.acf': CYBERPUNK_ACF,
    'C:\\Program Files (x86)\\Steam\\steamapps\\appmanifest_228980.acf': REDIST_ACF,
    'D:\\SteamLibrary\\steamapps\\appmanifest_730.acf': CS2_ACF,
    // 690790 (B:) deliberately absent — uninstall race, must be skipped.
  };
  const read = async (path: string): Promise<string> => {
    const body = FILES[norm(path)];
    if (body === undefined) throw new Error(`not covered: ${path}`);
    return body;
  };

  it('reads every appmanifest the vdf lists, across drives, and skips missing ones', async () => {
    const { games, steamFound } = await crawlSteamViaRead(read, { hideTools: true });
    expect(steamFound).toBe(true);
    expect(games).toEqual([
      { appid: '730', name: 'Counter-Strike 2' },
      { appid: '1091500', name: 'Cyberpunk 2077' },
    ]);
  });

  it('propagates a vdf read failure so the caller can fall back to PowerShell', async () => {
    await expect(
      crawlSteamViaRead(read, { steamPath: 'E:\\NoSteamHere' }),
    ).rejects.toThrow('not covered');
  });

  it('honors the steamPath override when locating the vdf', () => {
    expect(norm(steamVdfPath({ steamPath: 'D:\\Steam\\' }))).toBe(
      'D:\\Steam\\steamapps\\libraryfolders.vdf',
    );
    expect(norm(steamVdfPath())).toBe(
      'C:\\Program Files (x86)\\Steam\\steamapps\\libraryfolders.vdf',
    );
  });
});

describe('launchGameViaOpener', () => {
  it('opens the steam://run URL for the appid', async () => {
    const opened: string[] = [];
    await launchGameViaOpener(async (u) => {
      opened.push(u);
    }, '3932890');
    expect(opened).toEqual(['steam://run/3932890']);
  });

  it('propagates opener rejections (scheme denials must reach the caller)', async () => {
    await expect(
      launchGameViaOpener(async () => {
        throw new Error('scheme not declared');
      }, '42'),
    ).rejects.toThrow('scheme not declared');
  });
});

describe('iconGlobPatterns', () => {
  const norm = (p: string): string => p.replace(/\//g, '\\');

  it('targets the per-appid sha1 layout first, the legacy flat layout second', () => {
    const [sha1, flat] = iconGlobPatterns('1091500').map(norm);
    expect(sha1).toBe(
      'C:\\Program Files (x86)\\Steam\\appcache\\librarycache\\1091500\\' +
        '?'.repeat(40) +
        '.jpg',
    );
    expect(flat).toBe(
      'C:\\Program Files (x86)\\Steam\\appcache\\librarycache\\1091500_icon.jpg',
    );
  });

  it('honors the steamPath override and trims trailing separators', () => {
    const [sha1] = iconGlobPatterns('730', { steamPath: 'D:\\Steam\\' }).map(norm);
    expect(sha1).toBe(
      'D:\\Steam\\appcache\\librarycache\\730\\' + '?'.repeat(40) + '.jpg',
    );
  });

  it('stays inside one per-appid directory (no librarycache-wide walk)', () => {
    for (const pattern of iconGlobPatterns('42')) {
      expect(pattern).not.toContain('**');
      expect(norm(pattern)).toContain('\\librarycache\\42');
    }
  });
});
