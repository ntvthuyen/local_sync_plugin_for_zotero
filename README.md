# Local Sync for Zotero

This plugin syncs Zotero between two computers on the same local network, with no cloud involved. It works with Zotero 7 to 10, on Windows, macOS and Linux.

It syncs your library and group libraries: items, notes, annotations, collections, the trash and deletions. It also copies the PDFs.

## Setup (on both PCs)

1. In Zotero, go to **Tools → Plugins**, click the gear icon, choose **Install Plugin From File…**, and pick `local_sync_plugin_for_zotero.xpi`. Use the same version on both PCs.
2. Open **Settings → Local Sync**:
   - **Shared token:** click **Generate** on one PC, and copy the token to the other PC.
   - **Peer address:** the *other* PC's IP and port, e.g. `192.168.1.20:23120`.
3. Allow the port through the firewall on both PCs.
4. Click **Test connection**. Every line should show ✔.

**Before the first sync:** back up your Zotero data folder. Ideally, copy it from the main PC to the other PC so both PCs start from the same library. If you sync two separately built libraries, papers added on both PCs will show up twice.

## Syncing

- **Tools → Local Sync: Review changes…** lists every difference in both directions, with tick boxes. Nothing changes until you click **Sync selected**.
- **Tools → Local Sync: Sync now** syncs straight away, using the default ticks.

When the same item was edited on both PCs, it shows as a **Conflict** and starts unticked, so the newer copy is kept. Unticked changes are offered again next time.

## Linked PDFs (files outside Zotero's storage)

Linked paths from another computer, such as `G:\…\zotero\paper_pdfs\X.pdf`, don't work on other PCs. To fix them, on **each PC**:

1. Open **Settings → Local Sync → Fix linked file paths…**
2. Choose **that PC's** folder for the PDFs. On a PC that doesn't have them yet, use an empty folder with the same name as in the old paths, e.g. `zotero`.
3. Check the summary and click **OK**. A backup of the old paths is saved first.

Then sync. Any PDFs a PC is missing are copied across into the same subfolders.

## Good to know

- Zotero must be open on both PCs.
- Don't use zotero.org sync at the same time.
- Traffic is not encrypted, so only use this on a network you trust.
- Saved searches are not synced.

## Troubleshooting

Click **Test connection** first. It says what's wrong:

| Message | What to do |
|---|---|
| No answer / can't reach | Check the IP address, the firewall, the VPN, or guest Wi-Fi |
| Tokens don't match | Copy the token again |
| Different version | Install the same version on both PCs |
| **Can't copy** in the review window | The PC has no linked files folder yet: run **Fix linked file paths** on it |

For anything else, turn on **Help → Debug Output Logging**, sync again, and look for lines starting with `[LocalSync]`.
