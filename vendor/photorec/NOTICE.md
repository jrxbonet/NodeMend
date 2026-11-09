# PhotoRec / QPhotoRec 7.2

TidyWin launches unmodified PhotoRec as an independent executable. The engine is maintained by Christophe Grenier / CGSecurity and is available separately for free.

Official download: https://www.cgsecurity.org/wiki/TestDisk_Download
Documentation: https://www.cgsecurity.org/wiki/PhotoRec

The upstream COPYING and AUTHORS files remain beside each platform's executable. The matching TestDisk/PhotoRec source archive is included at `source/testdisk-7.2.tar.bz2`. These third-party components retain their original licenses; a TidyWin license does not remove recipients' rights to use or redistribute the GPL components separately.

Windows QPhotoRec also uses the DLLs supplied by CGSecurity, including Qt, Cygwin and other libraries. Review and preserve the corresponding third-party notices and source-access obligations before a commercial public release. This notice is an inventory, not a certification of license compliance.

Downloaded over HTTPS from cgsecurity.org on October 13, 2026:

- testdisk-7.2.win64.zip SHA-256 e97e203ce77b6b1a3a37d01beccf069dc6c4632b579ffbb82ae739cdda229f38
- testdisk-7.2.tar.bz2 SHA-256 f8343be20cb4001c5d91a2e3bcd918398f00ae6d8310894a5a9f2feb813c283f

On October 16, 2026 all four cached archives (Windows x64, Linux x86_64,
macOS Intel x86_64, and source) were compared with the SHA-256 values published
by CGSecurity at https://www.cgsecurity.org/testdisk_sha256.txt, linked by the
official download page. All matched. `HASHES.json` records those upstream
archive hashes, exact official download URLs, and hashes of every selected file
checked against the verified archives. No release signature was verified; these
pins establish consistency with the publisher's HTTPS checksum list, not an
independent signature or a license-compliance certification.

## Reproducing the vendor tree

After `npm ci`, run `node scripts/fetch-vendor.js win32` (or `linux`, `darwin`,
or `--all`). Node 18+ and a `tar` command with bzip2 support are required for the
Unix archives; Windows 11 includes the required tar. ZIP reading uses `yauzl`
from the installed Electron build toolchain. Every platform fetch also restores
the matching GPL source archive. Only x86_64 upstream binaries are pinned.

Windows `scripts/build.js` checks every selected vendor file before packaging
and downloads the pinned archive when the tree is missing, incomplete, or
modified. Downloads reject redirects and verify SHA-256 before reading archive
members. A mismatch fails the build; never update a pin just to bypass failure.
The script writes exact manifest-selected regular files into a temporary tree,
checks each file hash, and replaces the installed tree only after verification.
Archive-controlled paths, symlinks, and permissions are never extracted to disk.
Unix PhotoRec gets mode 755; terminfo data and notices get mode 644.

Platform trees, downloaded archives, and temporary staging folders are ignored
by Git. Keep this notice and `HASHES.json` in source control. Windows packages
include both metadata files, the Windows runtime, and matching source archive.
`node test/vendor.test.js` runs offline fixture checks for corrupted hashes,
unsafe paths/links, failed replacement, and temporary-file cleanup.
