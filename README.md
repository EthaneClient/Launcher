# Ethane Launcher

One-click launcher for [Ethane](https://github.com/EthaneClient/Ethane), the free and open source utility
client for Minecraft Fabric 1.21.11. No account, no Fabric installer, no mods folder to find: open it, hit Play.

On every Play it:

1. downloads Java 21 once (Adoptium), unless a Java 21 is already installed
2. installs Minecraft 1.21.11 and the newest stable Fabric Loader, checking what's already there
3. downloads `Ethane.jar` and the Fabric API from the [`JAR` release](https://github.com/EthaneClient/Ethane/releases/tag/JAR),
   re-downloading Ethane whenever a newer upload appears on that release
4. starts the game

Players get a random name (`Ethane1234`) they can change. Linking a Microsoft account in Settings is optional
and only needed for online-mode servers like Hypixel.

## Where things go

Everything lives in `%APPDATA%\.ethane` (`~/.ethane` on Linux, `~/Library/Application Support/.ethane` on macOS):

| Folder | What |
|---|---|
| `instance/` | the game folder: `mods/`, saves, config, screenshots, `options.txt` |
| `versions/`, `libraries/`, `assets/` | Minecraft and Fabric files |
| `runtime/java-21/` | the downloaded Java |
| `launcher/` | settings, the player name, `logs/game.log` |

Players can drop other Fabric mods into `instance/mods`; the launcher only manages `Ethane.jar` and `fabric-api-*.jar`.
Set `ETHANE_HOME` to use a different folder (handy for testing).

## Develop and build

| What | How |
|---|---|
| Run from source | `npm install`, then `npm start` |
| Build the installer | `build.bat` (or `npm run release`), giving `release\EthaneLauncherSetup.exe` |

The installer (`installer/Installer.cs`) is compiled with the C# compiler that ships with Windows, so the build
needs nothing besides Node. It installs per user (no admin prompt), adds Start menu and desktop shortcuts and an
Add/Remove Programs entry, and writes its own uninstaller. Its pages are rendered to `release/preview/` on every
build. Switches: `/silent`, `/run`, `/dir=<folder>`.

## Releasing

1. Bump `version` in `package.json`.
2. Run `build.bat`.
3. Make a GitHub release on this repo tagged `v<version>` and attach `EthaneLauncherSetup.exe` (keep that exact name: ethane.site links to `releases/latest/download/EthaneLauncherSetup.exe`).

Running launchers check this repo's latest release and show a "new version" banner linking to it
(this needs the repo to be public). Ethane itself needs no launcher release: upload a new `Ethane.jar` to the
`JAR` release of EthaneClient/Ethane and every launcher picks it up on its next Play.

## Code map

- `main.js`: window, tray, and the calls the page can make (`preload.js` is the only bridge)
- `backend/instance.js`: installs Minecraft, Fabric, Ethane and Fabric API
- `backend/game.js`: starts the game with Mojang's own arguments
- `backend/java.js`, `backend/accounts.js` (player name + optional Microsoft link), `backend/microsoft.js`, `backend/settings.js`
- `index.html`, `styles.css`, `app.js`: the interface, styled after ethaneclient.github.io
