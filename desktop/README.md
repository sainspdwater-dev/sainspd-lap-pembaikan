# SAINS PD Desktop (Windows pilot)

This is the existing dashboard packaged as a Windows application. It does not replace the GitHub Pages deployment or change production Worker/D1 data.

## Build

From this directory, run `npm ci`, `npm test`, `npm run smoke`, then `npm run package:win`. The local installer is written to `release/SAINS PD Setup 0.1.4.exe`. The build downloads frontend assets into the application bundle; running the built app does not need those CDNs. The installer is currently unsigned and must not be treated as an organization-approved mass rollout until a publisher certificate and staff security review are complete.

## Update notifications

- The desktop checks `https://raw.githubusercontent.com/sainspdwater-dev/sainspd-lap-pembaikan/main/desktop-update.json` at launch, when internet returns, and every four hours while running. It also has **Semak kemas kini** in the top ONLINE/OFFLINE menu (and on the login page). No notification is possible while the app is closed or offline.
- The feed is published **only after** the Windows installer has built, passed tests and been uploaded as a GitHub prerelease. A failed build does not announce a nonexistent installer. The app accepts only a newer numeric version, a 64-character SHA-256, a 40-character source commit, and a release page under the exact SAINS PD repository. It never downloads or executes an installer itself; the user opens the official release page and installs manually after saving/syncing drafts.
- The workflow `.github/workflows/desktop-release.yml` runs on changes to the deployed web or desktop sources on `main`, and can be run manually. It creates a unique `0.2.<run number>` pilot version. Until that workflow and desktop source are merged to `main` and the first release succeeds, the locally built 0.1.4 app will show no update. Check repository Actions permissions and release policy before enabling this for staff.
- Because these are unsigned pilot installers, an IT-approved signing/release process is required before organization-wide distribution. Do not treat a website-only change as an installable update until the matching desktop release exists.

## First use

1. Install under the staff member's own Windows account. One SAINS account is bound to that Windows profile.
2. Connect to the internet and sign in with the existing SAINS account. A successful Worker login can activate an offline code of at least eight characters. The code is protected with Windows `safeStorage`; it is not embedded in the installer.
3. Wait for the dashboard to finish fetching records. The compact ONLINE/OFFLINE indicator is beside the clock at the top; click it to see the last sync time and pending drafts before disconnecting.
4. Later, when the internet is unavailable, open SAINS PD and choose **Buka Offline** with the offline code. A valid online login must have occurred within the previous seven days.

## Offline behavior

- Previously synchronized repair records and dropdowns are stored in the app's persistent local profile (`localStorage`, mirrored to IndexedDB). A fresh installation on another PC starts with no records.
- Add/edit operations become local drafts, labelled **DRAF OFFLINE** in both Pengurusan Data and CRO Key In. They remain visible even when the current month/status filter would otherwise hide an unsent draft. For a new draft, the displayed month is derived from the complaint date solely for local display; the server remains authoritative after sync. Offline deletion is blocked.
- Once an authenticated online session is available, the app automatically downloads current records on opening, on reconnection, when the window becomes visible, and periodically while open. It automatically uploads local drafts only when the relevant server fields still match the original snapshot. Click the top ONLINE/OFFLINE indicator for the last download time, pending draft count, manual conflict review and online login action; no status banner covers the tables.
- A duplicate complaint number or changed server fields opens a comparison popup showing the record number and values before offline, on the server, and in the local draft. **Ya, overwrite** updates the existing server row; it never appends a second row for a known duplicate. **Tidak, kekalkan draf** leaves the draft on the PC. If multiple server rows have the same complaint number, or an edited server row has disappeared, overwrite is disabled. The **Semak & hantar draf** button reopens deferred conflicts.
- Automatic sync requires a valid online login. If the offline unlock was used or the session has expired, log in online again first. No password or permanent Worker token is saved for unattended login.
- Conflict comparison is client-side and rechecks immediately before writing, but the current Google Sheets Worker has no atomic revision lock. A simultaneous edit between that check and the write remains possible. Do not distribute this as a guaranteed conflict-free multi-user system until the Worker supports a server-side conditional write/revision check and staff pilot acceptance tests pass.
- If the server rejects an online change, the desktop UI reports the rejection instead of claiming a successful save.
- Online AI Agent / D1 / EPANET services remain unavailable offline. Online map tiles and D1 pipe geometry are not bundled; local DMA polygon overlays and cached repair records remain usable without a base map.
- The Worker remains the authority for synchronized records. No production hydraulic simulation is enabled by this installer.

## Operational safeguards

- The app binds a read-only static web server to `127.0.0.1:5500`, an origin already allowed by the existing Worker CORS policy. It quits if this port is occupied.
- The Electron renderer has `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`, and blocks navigation outside the local application. External map/WhatsApp links open in the system browser.
- The offline profile is OS-protected, but existing dashboard records and drafts in browser storage are not encrypted at rest. Use managed Windows accounts and full-disk encryption before real staff distribution.
- The first online login and Worker CORS preflight have not been validated using a real staff account in the automated smoke test. Test with a dedicated staff pilot account before distribution.
