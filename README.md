# VaM Backstage [![CI](https://github.com/cyberpunk2073/vam-backstage/actions/workflows/ci.yml/badge.svg)](https://github.com/cyberpunk2073/vam-backstage/actions/workflows/ci.yml)

VaM Backstage is a modern way to manage your [Virt-a-Mate](https://www.virtamate.com/) library. It keeps track of the packages you install directly and their dependencies, keeping unwanted dependency content out of VaM’s browser while leaving the packages themselves untouched.

Explore and organize your collection in a fast desktop interface, with powerful search, precise filters, and custom labels. Discover and install resources from the Hub in one click, with missing dependencies resolved and downloaded in parallel while you keep browsing.

![VaM Backstage — library view](docs/screenshot.png)

[![Download for Windows](https://img.shields.io/github/v/release/cyberpunk2073/vam-backstage?label=Download%20for%20Windows&style=for-the-badge)](https://github.com/cyberpunk2073/vam-backstage/releases/latest/download/vam-backstage-setup.exe) [![Other platforms](https://img.shields.io/badge/Other%20platforms-releases-blue?style=for-the-badge)](https://github.com/cyberpunk2073/vam-backstage/releases/latest)

## Features

**Keep dependency clutter out of VaM.** Backstage distinguishes packages you chose to install from those present only because another package needs them. It keeps those dependencies installed and working while hiding their scenes, looks, poses, clothing, and hairstyles from VaM's content browser. See the dependency tree for any package, spot missing or broken dependencies, and remove dependencies that become unused when you uninstall.

**Install from the Hub without stopping what you are doing.** Search the Hub and open complete resource pages inside Backstage. Installing a resource queues its missing dependencies and downloads everything in parallel in the background, so you can keep browsing, organizing, and starting other installs. Save resources to a wishlist for later and check installed packages for updates.

**Find and organize anything.** Search across packages and individual content, then narrow the results by author, type, tags, status, or your own labels. Apply labels, hide content, and mark favorites across whole packages or individual items, including in bulk. When you need more control, advanced searches can combine terms and exclusions such as `@MacGruber hair -male`.

**Extract and convert presets.** Extract appearance and clothing presets from scenes in one action, or convert legacy looks to appearance presets. This is especially useful for look packages that ship only as demonstration scenes and otherwise require you to create reusable presets manually.

**Disable packages intelligently.** Temporarily take packages out of VaM without uninstalling them. Backstage follows the dependency graph: disabling a package also disables dependencies that no enabled package still needs, and enabling it restores its required dependencies. Work with one package or many at once.

**Works with the library you already have.** Backstage handles packages in subfolders and loose content, can register existing offload directories used by tools such as BrowserAssist, and picks up changes made outside the app. No reorganization or migration is required.

**Manage your library from another computer.** Run Backstage on the machine that stores your VaM library, then connect over your local network to browse, download, and manage packages from another computer.

## Development

Requires Node.js >= 24.

```bash
npm install
npm run dev
```

Build for your platform:

```bash
npm run build:win
npm run build:mac
npm run build:linux
```

For a detailed project overview, architecture, and implementation notes, see [docs/Implementation.md](docs/Implementation.md).
