# NodeMend automation and deployment guide

> **Since 1.5.0 NodeMend is free and open source and needs no key.** The full build is named `NodeMend` (`NodeMend.exe`, `NodeMend-portable.exe`) and runs unattended mode, reports, policy and audit for everyone. A signed key is optional and only adds an organisation name to titles and reports; it cannot unlock or restrict anything. The command-line switches, exit codes, policy schema, report layout and audit format below are unchanged. Wherever this guide says a feature needs an "Enterprise" key or is refused with `LICENSE_REQUIRED`, read it as history: that refusal now happens only in the smaller Solo build, which does not contain the automation modules.

The original text follows.

NodeMend ships in two editions built from one code base:

| | NodeMend Solo | NodeMend Enterprise |
|---|---|---|
| Artifacts | `NodeMend-Solo.exe` (folder), `NodeMend-Solo-portable.exe` | `NodeMend-Enterprise.exe` (folder), `NodeMend-Enterprise-portable.exe` |
| Licensed use | one PC, interactive | fleet: unattended runs, central reports, policy, audit, branding |
| Without a valid key | **Free** (internal edition `evaluation`) | **Free** (internal edition `evaluation`) |

Free mode includes basic cleaning, analysis, diagnostics, update checks, scans, lists and Export. Paid tools are refused with `LICENSE_REQUIRED` and the License tab opens. There is no trial clock and no stored trial state.

The effective edition is `min(build edition, license edition)`: an Enterprise key in a Solo build runs as Solo (the banner says so); a Solo key in an Enterprise build runs as Solo. Enterprise features additionally require the matching `features` entry in the key (`unattended`, `report`, `policy`, `audit`, `brand`; a key without a `features` list has all five).

License verification and local policy work fully offline. Update tools and explicitly selected external services may use the network. The optional NodeMend Cloud maintenance add-on is backlog only; it is separate from the NamerGate remote connectivity product and is not implemented or approved by this rename.

NodeMend is the new product name; the editions remain Solo and Enterprise. The checkout is `D:\Software Projects\NodeMend` (renamed from TidyWin on 2026-10-17). The rename preserves issued licenses: the signed token prefix remains `TIDYWIN1.`, its payload `product` remains `tidywin`, and the license filename remains `TidyWin.lic`. New `NODEMEND_*` environment names accept the existing `TIDYWIN_*` names as legacy aliases; `window.tidy` and existing error identifiers remain compatible. Do not rewrite signed tokens or rename publisher key files.

Machine state now uses `%ProgramData%\NodeMend`; startup moves existing `%ProgramData%\TidyWin` state before license resolution when the destination is absent or empty. The same migration moves `%APPDATA%\tidywin` to `%APPDATA%\nodemend` and portable `%TEMP%\TidyWin-portable` to `%TEMP%\NodeMend-portable`. A nonempty destination is preserved and the legacy source is left untouched; no files are overwritten. A conflict, unsafe path or failed move stops startup with exit 4 and `DATA_MIGRATION_REQUIRED` before license/policy resolution or maintenance execution. Resolve the folder conflict before restarting; unattended runs write the reason to the requested log (or a unique temporary migration log). Successful startup creates the new state directory before assigning Electron userData. Check the License tab's reported paths and candidates after upgrading. Policy discovery accepts `NodeMend.policy.json` with `TidyWin.policy.json` as a legacy fallback. Historical `docs/REVIEW-*` and `docs/PREWORK-*` records retain their original names as review evidence.

The intended download route is `/downloads/nodemend`, with `NodeMend-Solo` and `NodeMend-Enterprise` artifact names. This guide describes local packaging and does not claim a published release or deployed download route.

---

## 1. License placement

A license is a one-line token `TIDYWIN1.<payload>.<signature>` (300–600 characters). The file form `TidyWin.lic` may be the bare token or the armored form the keygen writes (`-----BEGIN…-----` lines, `#` comment lines, 64-column wrapping, CRLF); whitespace and wrappers are ignored on read, so a key pasted from an e-mail works as-is.

NodeMend looks in five places, in this order of precedence:

| # | Source | Location | Typical use |
|---|---|---|---|
| 1 | `--license=<token or path>` | command line | scheduled tasks, scripted runs; survives the UAC relaunch |
| 2 | `NODEMEND_LICENSE` (legacy `TIDYWIN_LICENSE`) | environment variable (token or path) | same, via GPO environment settings |
| 3 | `exe` | `TidyWin.lic` next to the exe (for the portable build: next to `NodeMend-Enterprise-portable.exe`, i.e. the thumb drive) | technician USB stick |
| 4 | `programdata` | `%ProgramData%\NodeMend\TidyWin.lic` | GPO / Intune / `--install-license` drop location, all users |
| 5 | `userdata` | `%APPDATA%\nodemend\TidyWin.lic` (portable build: `%TEMP%\NodeMend-portable\TidyWin.lic`) | "Only me" activation from the License tab |

Rules:

- A **valid** `--license` or `NODEMEND_LICENSE` (legacy `TIDYWIN_LICENSE`) wins outright.
- Otherwise the best valid file key wins: Enterprise beats Solo, ties go to the table order.
- If nothing is valid, NodeMend runs as Evaluation and the banner shows why the first key it *found* was rejected (expired, signature invalid, build newer than maintenance…). The License tab's **candidates** table lists every location it checked — start there when a key "does not work".
- Policy `allowUserLicense: false` removes location 5 from consideration.
- Each location is read with a 3-second timeout; an unreachable path never delays startup.

Dates are compared at day granularity against the local clock. An expired key or a build newer than the key's `maint` date degrades to Evaluation; nothing is ever a hard stop, and a wrong clock cannot lock you out of read-only use.

### Intune / SCCM recipe (`--install-license`)

Package `NodeMend-Enterprise.exe` (the folder build) together with your `TidyWin.lic` and run, as SYSTEM:

```
NodeMend-Enterprise.exe --install-license=.\TidyWin.lic --quiet
```

It verifies the key, copies it to `%ProgramData%\NodeMend\TidyWin.lic`, writes `%ProgramData%\NodeMend\activation.json` and exits without opening a window. Exit codes: `0` installed · `2` file missing/unreadable · `3` key invalid or not an Enterprise key. The log is written to `%ProgramData%\NodeMend\logs\<stamp>-<runid>-install-license.log`.

**Detection rule** (Intune "file exists"): `%ProgramData%\NodeMend\activation.json`.

NodeMend never changes ACLs. Lock the folder down yourself so standard users cannot swap the key or edit the policy:

```
icacls "%ProgramData%\NodeMend" /inheritance:r /grant:r Administrators:F SYSTEM:F Users:RX
```

Run this once after the first install (the folder is created by `--install-license` or by the first elevated start). `Users:RX` keeps the key, policy and audit path readable; only the audit and report *subfolders* need write access for unelevated GUI sessions, and NodeMend falls back to the per-user folder when it cannot write there.

---

## 2. Policy file (`NodeMend.policy.json`)

Discovery, first found wins, no merging: `--policy=<path>` → `NODEMEND_POLICY` (legacy `TIDYWIN_POLICY`) → the machine data folder → the executable folder. In each folder, `NodeMend.policy.json` is preferred and `TidyWin.policy.json` is accepted as the legacy fallback. An explicitly selected policy path is used as supplied.

The policy is enforced only when the effective edition is Enterprise and the key has the `policy` feature; otherwise it is loaded for display and the log says `policy ignored (edition)`. Invalid JSON or a schema error means **allow-all** (`{}`) plus a red error in the License tab; an unattended run refuses to start on an invalid policy (exit 4) so a typo can never silently widen what a scheduled task does.

Schema v1 — every key is optional, unknown keys are ignored, wrong types are an error:

```json
{
  "version": 1,
  "orgName": "Contoso IT",
  "supportText": "Problems? Call the service desk on 4444",
  "hideTabs": ["programs", "startup", "duplicates", "updates", "health", "cleaner"],
  "disable": ["clean", "recycle", "cleanmgr", "dism-restore", "dism-cleanup", "sfc", "defender",
              "wu-install", "drivers-install", "winget-upgrade", "uninstall", "startup-toggle",
              "dup-trash", "do-all", "quick", "user-license"],
  "cleaner": { "on": ["user-temp", "win-temp"], "off": ["npm", "recycle"], "lock": true },
  "defaults": { "dupMinSize": 1048576 },
  "unattended": { "allow": true, "profile": "quick", "steps": ["diag", "clean", "defupd"], "timeoutMin": 150, "requireElevation": false },
  "reportDir": "\\\\srv\\nodemend$",
  "audit": { "eventLog": false },
  "lockLicensePanel": false,
  "allowUserLicense": true
}
```

| Key | Effect |
|---|---|
| `orgName`, `supportText` | "Managed by <orgName>" banner, sidebar org line, `## Support` section in reports |
| `hideTabs` | nav buttons removed; the tab cannot be opened |
| `disable` | actions refused in the main process (`POLICY_DENIED:<token>`) and greyed out in the UI. `do-all` / `quick` / `user-license` are UI/activation tokens |
| `cleaner.on` / `off` | categories forced on/off. `lock: true` pins the selection: cleaning anything outside the allowed set is refused (`POLICY_DENIED:cleaner-lock`) |
| `defaults.dupMinSize` | initial minimum size for the duplicate finder (bytes) |
| `unattended.allow` | `false` → `--unattended` exits 4 |
| `unattended.profile`, `steps` | defaults for `--unattended` (`--steps` / `--profile` on the command line override; see §3) |
| `unattended.timeoutMin` | default hard limit (180 when absent) |
| `unattended.requireElevation` | `true` → an unelevated unattended run exits 5 instead of continuing with a warning |
| `reportDir` | central report directory (local path or UNC, `%VAR%` expanded). Overrides the License tab setting |
| `audit.eventLog` | `true` → mirror audit events to the Application event log (§5) |
| `lockLicensePanel` | Activate/Remove replaced by "Licensing is managed by your organization" |
| `allowUserLicense` | `false` → per-user `TidyWin.lic` ignored |

Action tokens: `clean recycle cleanmgr dism-restore dism-cleanup sfc defender wu-install drivers-install winget-upgrade uninstall startup-toggle dup-trash`. `defender` is never license-gated but can be disabled by policy.

Reload without restarting: License tab → **Reload policy**.

---

## 3. Unattended mode

```
"C:\Program Files\NodeMend\NodeMend-Enterprise.exe" --unattended --profile=quick --report-dir=\\srv\nodemend$ --reboot-exit-code
```

| Switch | Meaning | Default |
|---|---|---|
| `--unattended` | run headless and exit | — |
| `--profile=quick\|full\|smoke` | step set | `policy.unattended.profile` or `quick` |
| `--steps=a,b,c` | explicit step keys, overrides the profile; unknown key → exit 2 | — |
| `--report-dir=<path>` | report directory (local or UNC; relative to the exe folder for the portable build) | `policy.reportDir` → License tab setting → `<portable exe dir>\reports` |
| `--policy=<path>` | policy file | discovery (§2) |
| `--license=<path\|token>` | license | discovery (§1) |
| `--log=<path>` | log file | `%ProgramData%\NodeMend\logs\<stamp>-<runid>-<profile>.log` |
| `--timeout-min=N` | hard limit; children are killed and the run exits 6 | `policy.unattended.timeoutMin` or 180 |
| `--reboot-exit-code` | return 3010 when updates need a restart and nothing failed | off |
| `--no-elevate` | accepted for symmetry; unattended never triggers UAC | — |

Solo builds refuse `--unattended` with exit code `3` and, since 2026-10-09, write one line `EXIT 3 (license does not permit): LICENSE_REQUIRED ...` to the same log location (or `--log=<path>`).

Profiles:

| Profile | Steps |
|---|---|
| `quick` | `diag`, `clean`, `defupd`, `dism`, `refresh` |
| `full` | `diag`, `clean`, `cleanmgr`, `dism`, `sfc`, `chkdsk`, `defupd`, `defscan`, `wu`, `drivers`, `winget`, `dup`, `maint`, `refresh` |
| `smoke` | `diag`, `refresh` (a 1-minute connectivity/permissions check for new deployments) |

Step keys for `--steps`: `diag clean cleanmgr dism sfc chkdsk defupd defscan wu drivers winget dup maint refresh`.

### Exit codes

| Code | Meaning |
|---|---|
| `0` | ok |
| `1` | at least one step failed (details in the log and the report) |
| `2` | bad arguments (unknown profile/step, non-numeric timeout) |
| `3` | license does not permit (not Enterprise, or key lacks the `unattended` feature) — log contains `LICENSE_REQUIRED` |
| `4` | policy forbids (`unattended.allow: false`) or the policy file is invalid |
| `5` | not elevated and the policy requires elevation |
| `6` | timeout — remaining steps are recorded as `skipped: timeout` |
| `7` | another NodeMend instance is already running unattended |
| `3010` | ok, reboot required (only with `--reboot-exit-code`) |

NodeMend is a GUI-subsystem executable: **nothing is written to stdout**. The log file and the exit code are the only outputs. The portable launcher forwards all parameters and propagates the exit code, so both build formats work in Task Scheduler.

The run log contains the argument summary, license/policy resolution, every PowerShell/DISM/winget output line, `RESULT: OK|FAIL (<done> ok, <failed> failed, <skipped> skipped)` and `EXIT <code>`.

### Scheduling

From the License tab (Enterprise → Unattended card): **Install weekly task (Sun 03:00)** registers `NodeMend Maintenance` as SYSTEM with highest privileges through `ps\schedule.ps1`; **Remove task** unregisters it; the card shows the last result and next run. The same script can be scripted:

```
powershell -NoProfile -ExecutionPolicy Bypass -File "C:\Program Files\NodeMend\ps\schedule.ps1" -Install -Exe "C:\Program Files\NodeMend\NodeMend-Enterprise.exe" -Arguments "--unattended --profile=quick --report-dir=\\srv\nodemend$ --reboot-exit-code" -Day Sunday -Time 03:00
powershell -NoProfile -ExecutionPolicy Bypass -File "...\ps\schedule.ps1" -Status
powershell -NoProfile -ExecutionPolicy Bypass -File "...\ps\schedule.ps1" -Remove
```

Or plain `schtasks`:

```
schtasks /Create /TN "NodeMend Maintenance" /SC WEEKLY /D SUN /ST 03:00 /RU SYSTEM /RL HIGHEST /F /TR "\"C:\Program Files\NodeMend\NodeMend-Enterprise.exe\" --unattended --profile=quick --report-dir=\\srv\nodemend$ --reboot-exit-code"
```

New installs use `NodeMend Maintenance`. Existing `TidyWin Maintenance` tasks remain available for status and removal; this rename does not automatically change a registered task. Remove the legacy task and install the new one explicitly after upgrading a protected folder build.

The task's "Last Run Result" shows the exit code (`0x0`, `0x1`, `0xBC2` = 3010 …).

### Session-0 caveats (running as SYSTEM)

- Per-user cleaner categories (`%TEMP%`, `%LOCALAPPDATA%` browser caches, …) resolve to the **SYSTEM profile**, not to logged-on users. System-wide categories (Windows Temp, Delivery Optimization, Windows Update cache, crash dumps, WER) are the ones that matter in a scheduled run. Per-user profile expansion is planned for a later release.
- **winget** is a per-user Appx and is not available to SYSTEM: the `winget` step is recorded as `skipped: unavailable`.
- Keep **`cleanmgr` out of unattended profiles**: Disk Cleanup opens dialogs that its watcher cannot see in session 0, and it would sit until the timeout. `quick` deliberately omits it.
- Defender, DISM, SFC, CHKDSK `/scan`, Windows Update and driver installs all work as SYSTEM.
- Nothing can prompt: confirmations are auto-accepted and logged (`auto-confirm: …`), notices are logged (`notice: …`).
- Interactive test of a session-0 run: `psexec -s -i 0 "C:\Program Files\NodeMend\NodeMend-Enterprise.exe" --unattended --profile=smoke --log=C:\Temp\tw.log`, then `echo %ERRORLEVEL%`.

---

## 4. Reports

### Report directory

Resolution: `--report-dir` → `policy.reportDir` → License tab setting (`settings.json` in the user profile) → `<portable exe dir>\reports` for the portable build → not configured. `%VAR%` tokens are expanded.

A local copy is always kept in `%ProgramData%\NodeMend\reports\<stamp>-<runid>-<profile>.json|.md` (falls back to the user profile when ProgramData is read-only).

Layout of the central directory (`HOST` = computer name, `stamp` = `yyyy-MM-dd_HHmm` local, `runid` = 16 random hex characters so two runs in the same minute never collide):

```
\\srv\nodemend$\
  <HOST>\<stamp>-<runid>-<profile>.json   full report (schema below)
  <HOST>\<stamp>-<runid>-<profile>.md     the same report as Markdown
  _latest\<HOST>.json                most recent report per host (atomic replace)
  _activations\<HOST>.json           the host's activation record (license id, licensee, seats, user, app version)
```

`profile` is `quick|full|smoke` for unattended runs and `manual` for reports sent from the GUI (Export, "Do all the things", **Send report now**).

If the directory is unreachable for any reason (share down, ENOTDIR, access denied, 20-second timeout) the pair is queued in `%ProgramData%\NodeMend\outbox\` and the run still exits with its normal code. The outbox is flushed at every start (GUI and unattended, oldest first) and items older than 90 days are dropped. The License tab shows the outbox count; an audit event `report-queued` (event-log ID 140) is written each time a report is queued.

### Share permissions for SYSTEM tasks

A task running as SYSTEM authenticates to the share as the **computer account** (`DOMAIN\HOST$`). Grant **Domain Computers: Modify** on both the share and the NTFS folder (Modify, not Full Control — the hosts only need to create and replace files). Workgroup machines have no computer account; use a local report directory there and collect it with your RMM, or run the task as a service account.

### Report JSON (schema 1)

```
{ schema: 1, host, domain, user, elevated, mode: 'gui'|'unattended', profile,
  started, finished, durationSec, exitCode, rebootRequired,
  app: { version, build, edition, licenseId, licensee, brand },
  steps: [{ key, label, state: 'done'|'failed'|'skipped', secs, reason }],
  sys: { os, build, displayVersion, model, ramTotal, ramFree, uptimeHours, pendingReboot, lastHotfix, volumes, disks, defender } | null,
  clean: { totalFreed, freeBefore, freeAfter, results } | null,
  diag: { errorCount, crashes, appCrashes, smartFailure, pendingReboot, stoppedAutoServices: [names] } | null,
  wu: { pending, titles, rebootRequired } | null,
  drivers: { offered, titles, problemDevices: [names] } | null,
  winget: { available, items: [{ id, version, available }] },
  dup: { groups, wasted, filesScanned } | null,
  log: [lines] }
```

`steps[].reason` for skipped steps: `stop` (user pressed Stop), `license`, `policy`, `unavailable` (winget under SYSTEM), `timeout`. `exitCode` is filled for unattended runs only. Every report carries the license id so a report from an unlicensed or mislicensed host is recognisable.

The Markdown twin starts with `# NodeMend Enterprise maintenance report — <date>` and `Prepared by <brand.name> for <host>` (or `Licensed to <licensee> (<id>)`), and ends with a `## Support` section built from `brand.support` and `policy.supportText`.

Summarising a fleet is a one-liner in PowerShell:

```
Get-ChildItem \\srv\nodemend$\_latest\*.json | ForEach-Object { Get-Content $_ | ConvertFrom-Json } |
  Select-Object host, finished, exitCode, rebootRequired, @{n='freedMB';e={[int]($_.clean.totalFreed/1MB)}}, @{n='errors';e={$_.diag.errorCount}} |
  Sort-Object finished -Descending | Format-Table
```

---

## 5. Audit log

Enterprise keys with the `audit` feature write one JSON object per line to `%ProgramData%\NodeMend\audit\<yyyy-MM>.jsonl` (user-profile fallback when ProgramData is read-only; the path in use is shown in the License tab). Files older than 12 months are deleted at startup. Audit writes never block or fail an action.

```
{ "ts": ISO-8601, "opId": "<8 hex>", "host", "user", "elevated", "mode": "gui"|"unattended",
  "edition", "licenseId",
  "event": "start"|"done"|"denied"|"run-start"|"run-end"|"license-activate"|"license-remove"|"policy-load"|"report-queued",
  "action": "<action token or null>", "target": string|object|null,
  "result": { "ok", "freed", "deleted", "skipped", "exitCode", "error" }|null, "secs": number|null }
```

`target` never contains file paths for the cleaner (category ids only); duplicate trashing records the paths, uninstall records `{ kind, id, name }`, startup toggles `{ name, hive, key, enable }`, winget the package id or `--all`. A `start` and its `done` share the same `opId`.

Event log mirror (`"audit": { "eventLog": true }`): entries are written to the **Application** log, source `NodeMend`, via `eventcreate.exe` (the first write needs an elevated token to register the source):

| ID | Event | Type |
|---|---|---|
| 101 | unattended run started | Information |
| 102 | unattended run finished | Information (Warning when a step failed) |
| 110 | destructive action done | Information (Warning on failure) |
| 120 | action denied by policy | Warning |
| 130 | action denied by license | Warning |
| 140 | report queued to outbox | Warning |

Filter with `Get-WinEvent -FilterHashtable @{ LogName='Application'; ProviderName='NodeMend'; Id=120,130 }`.

---

## 6. Branding and seats

An Enterprise key can carry `brand: { name, support }`. With the `brand` feature the sidebar shows the brand name (or `policy.orgName`, or the licensee), the window title reads `NodeMend Enterprise – <org>`, and reports are "Prepared by <brand.name>". The License tab shows `N seats, M activations recorded` — `M` is the number of files in `_activations\` on the report share when it is reachable. Seats are informational: NodeMend does not refuse the N+1th activation (see §8).

---

## 7. Manual release matrix

Before each release the following is checked by hand:

1. Solo portable from a FAT32 thumb drive with `TidyWin.lic` beside it, offline, clock set to 2010 → licensed, nothing written to the host.
2. Enterprise folder build as a SYSTEM scheduled task writing to a UNC share (computer account granted Modify) → report lands, exit code visible in Task Scheduler.
3. `psexec -s -i 0` session-0 launch of `--unattended --profile=smoke` completes.
4. Enterprise build with a Solo key shows the Solo badge.
5. Each of the four artifacts launches once with a key next to the exe.

---

## 8. Tamper resistance — an honest statement

NodeMend is plain, readable JavaScript running in Electron without an archive or obfuscation. Anyone with local admin rights can edit the public-key list or remove the gate. The licensing exists to keep honest customers honest, not to stop a determined attacker:

- one enforcement point in the main process (all machine-changing IPC goes through the same guard);
- Solo artifacts physically omit the `enterprise/` folder — there is nothing to unlock;
- the license id is stamped into every report and audit line, so a modified copy is visible in the fleet data;
- no online checks, no machine binding, no trial clock — nothing that can lock out a legitimate customer or a technician working offline;
- Authenticode signing of the executables is planned; it does not change the above.

Treat a license key like any other credential: it is bearer-style and can be copied.

---

## 9. Key management (for the publisher)

Licenses are signed with an Ed25519 private key generated by `node tools/keygen.js init`; the matching public key is embedded in `lib/license-codec.js`. The private key is the whole business:

- keep `keys/tidywin-ed25519.key` (encrypted PKCS#8) **and its passphrase** in the password manager, as two separate entries;
- keep an offline copy (encrypted USB stick in a different place);
- **never** in the repository (`keys/` is gitignored), never in OneDrive or any synced folder, never in a chat log or a ticket;
- `keys/issued.jsonl` and `keys/issued/<id>.lic` are the register of every key ever issued — back them up with the key;
- if the key is ever exposed: `node tools/keygen.js rotate`, add the second `PUBLIC_KEYS` entry, ship a release, re-issue customer keys against the new key over time, then drop the old entry.

`tools/keygen.js` and `keys/` never ship in any artifact; the build asserts that no `PRIVATE KEY` string is present in the output.

## 10. Building the editions (for the publisher)

One repository produces both editions in both formats. `scripts/build.js` writes a temporary
`edition.json` (`{ edition, productName, version, builtAt }`) into the project root, runs
`@electron/packager` and/or `electron-builder`, checks every artifact, and deletes `edition.json`
again so it can never leak into `npm start` or the next build.

| Command | Output |
|---|---|
| `npm run package` | `dist\NodeMend-Solo-win32-x64\NodeMend-Solo.exe` (folder build) |
| `npm run package:enterprise` | `dist\NodeMend-Enterprise-win32-x64\NodeMend-Enterprise.exe` |
| `npm run portable` | `dist\portable\NodeMend-Solo-portable.exe` (single-file, unpacks to `%TEMP%\NodeMend-Solo`) |
| `npm run portable:enterprise` | `dist\portable\NodeMend-Enterprise-portable.exe` (unpacks to `%TEMP%\NodeMend-Enterprise`) |
| `npm run build` | all four; runs `npm run smoke` first (add `--skip-smoke` to `scripts/build.js` calls to bypass) |

Solo artifacts physically omit the `enterprise/` folder; every artifact is checked for the
absence of `keys/`, `tools/`, `test/`, `docs/`, the test harnesses and any private-key material.
Windows PowerShell must be able to read `ps\*.ps1` from disk, so asar stays off in both formats.

Notes on generated files:
- The Markdown report's first line is `# NodeMend maintenance report — <date>`; line 2 is the
  licensing line (`Prepared by <brand> for <host>` / `Licensed to <licensee> (<id>)` /
  `Free copy of NodeMend — cleaning included`); line 3 carries the product name, version and host.
- A key pasted into the License tab is stored verbatim (armor and `#` comment lines kept).
  "Remove license" only deletes a key file next to the exe, in `%ProgramData%\NodeMend` or in
  the per-user folder; keys supplied through `--license`, `NODEMEND_LICENSE` or legacy `TIDYWIN_LICENSE` are never deleted.
