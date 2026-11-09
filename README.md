# NodeMend

A free and open-source maintenance toolkit for Windows, by [Namer-Lavan](https://namer-lavan.com).

NodeMend cleans up disk space, checks system health, runs Windows' own repair tools, installs updates and manages startup programs from one window. Every feature is unlocked. There is no paid tier, no account and no key to enter.

- Project page and downloads: https://namer-lavan.com/downloads/nodemend
- Source code and issue tracker: https://github.com/jrxbonet/NodeMend
- Licence: GNU General Public License, version 3 or later (see [LICENSE](LICENSE))

## What it does

| Area | Tools |
|---|---|
| Cleaning | Temp files, browser caches, thumbnails, Recycle Bin, Windows Update cache and other categories; Windows Disk Cleanup |
| Health and repair | Diagnostics, DISM scan and restore, SFC, CHKDSK scan, Defender update and quick scan, Windows automatic maintenance |
| Updates | Windows Update, driver updates, `winget` upgrades |
| Programs | Startup manager, uninstaller (registry and Store apps), duplicate-file finder, disk analyzer |
| Extras | File recovery with the bundled PhotoRec, browser privacy cleaning, pausing background apps, timed cache cleaning |
| Automation | "Do all the things" sequence, unattended command-line runs with exit codes, report folder, policy file, audit log |

The automation features are documented in [docs/ENTERPRISE.md](docs/ENTERPRISE.md).

NodeMend makes real changes to the computer it runs on, and some tools need administrator rights. It asks for elevation only when you choose a tool that needs it. Read what a tool does before running it.

## Download

Get the portable Windows build from the [project page](https://namer-lavan.com/downloads/nodemend). The executable is not code-signed, so Windows SmartScreen will show a warning the first time; compare the file's SHA-256 with the published checksum before running it.

## Run from source

Requires Windows 10 or 11 and Node.js 22 or newer.

```
git clone https://github.com/jrxbonet/NodeMend.git
cd NodeMend
npm install
npm start
```

## Test and build

```
npm run smoke        # unit tests for the key codec and gate, then the headless Electron smoke test
npm run build        # dist/NodeMend-win32-x64/ and dist/portable/NodeMend-portable.exe
```

Run the smoke test and the build one after the other, never at the same time: the build writes a temporary `edition.json` that changes what a running test sees.

`npm run build:all` also produces the smaller "Solo" build, which leaves out the `enterprise/` automation modules.

## The optional organisation key

NodeMend needs no key. A signed organisation key (the About tab, `--license`, or a `TidyWin.lic` file) only adds an organisation's name to the window title and reports. It cannot unlock or restrict anything. The `TIDYWIN1.` prefix and `TidyWin.lic` file name are kept from the project's earlier name so existing keys keep working.

## Support the project

NodeMend is free. If it saved you time, you can [donate](https://namer-lavan.com/downloads/nodemend#support). Donations are optional and unlock nothing.

## Contributing

Bug reports and pull requests are welcome. Please run `npm run smoke` before sending a change, and never commit anything under `keys/`.

If you publish a modified version, please give it a different name so people can tell it apart from the builds Namer-Lavan publishes.

## Third-party software

File recovery uses PhotoRec from the TestDisk project by CGSecurity, licensed under the GNU General Public License. It is fetched by `scripts/fetch-vendor.js`, verified against `vendor/photorec/HASHES.json`, and shipped with its licence and matching source archive. See `vendor/photorec/NOTICE.md`.

## Licence

Copyright (C) 2026 Namer-Lavan.

This program is free software: you can redistribute it and/or modify it under the terms of the GNU General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version.

This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public License for more details.
