/* global Zotero, Components, ChromeUtils, IOUtils, PathUtils */
/*
 * Local Sync for Zotero  (protocol 2)
 *
 * Each computer runs a small token-protected HTTP server.
 * A sync started on A works in two phases:
 *   1. Plan:  A fetches B's changes and classifies them against its own library
 *             (incoming rows). A sends its own changes to B, and B classifies them
 *             (outgoing rows). Nothing is written yet.
 *   2. Apply: A applies the ticked incoming rows, then tells B to apply the
 *             ticked outgoing rows. B downloads any files it needs from A.
 * "Sync now" uses the default ticks; "Review changes…" lets you choose.
 *
 * Libraries are identified across PCs as "u" (My Library) or "g<groupID>".
 */

var LS_Cc = Components.classes;
var LS_Ci = Components.interfaces;

var LS_NetUtil;
try {
  ({ NetUtil: LS_NetUtil } = ChromeUtils.importESModule("resource://gre/modules/NetUtil.sys.mjs"));
} catch (e) {
  ({ NetUtil: LS_NetUtil } = ChromeUtils.import("resource://gre/modules/NetUtil.jsm"));
}

/*
 * The plugin's scope may lack some browser globals (IOUtils, PathUtils, TextEncoder, TextDecoder),
 * depending on the Zotero version. Make sure each one exists: import it if we can, otherwise borrow it
 * lazily from a Zotero window (a window may not be open yet when the plugin starts).
 */
(function () {
  for (const name of ["IOUtils", "PathUtils", "TextEncoder", "TextDecoder"]) {
    let present = false;
    try {
      present = typeof globalThis[name] !== "undefined";
    } catch (e) {}
    if (present) continue;
    try {
      Components.utils.importGlobalProperties([name]);
      if (typeof globalThis[name] !== "undefined") continue;
    } catch (e) {}
    Object.defineProperty(globalThis, name, {
      configurable: true,
      get() {
        let w = null;
        try {
          w = Zotero.getMainWindow();
        } catch (e) {}
        if (!w || typeof w[name] === "undefined") {
          try {
            w = Services.appShell.hiddenDOMWindow;
          } catch (e) {}
        }
        const v = w ? w[name] : undefined;
        if (v === undefined) throw new Error(`${name} isn't available in this version of Zotero`);
        return v;
      },
    });
  }
})();

var LS_PROTOCOL = 2;
var LS_STATUS = { 200: "OK", 400: "Bad Request", 401: "Unauthorized", 404: "Not Found", 409: "Conflict", 500: "Internal Server Error" };
var LS_DELETION_RETENTION_DAYS = 180;
var LS_WATERMARK_OVERLAP_SEC = 120;
var LS_PLAN_TTL_MS = 60 * 60 * 1000;
var LS_LINK_MODES = { imported_file: 0, imported_url: 1, linked_file: 2, linked_url: 3, embedded_image: 4 };

LanSync = {
  id: null,
  version: null,
  rootURI: null,
  server: null,
  httpd: null,
  timer: null,
  observerID: null,
  prefObservers: [],
  deletions: [],
  _saveChain: Promise.resolve(),
  syncing: false,
  planning: false,
  pendingPlans: new Map(),
  windowElements: new Map(),

  // ================================================================ lifecycle

  init({ id, version, rootURI }) {
    this.id = id;
    this.version = version;
    this.rootURI = rootURI;
    Zotero.LanSync = this;

    if (!this.getPref("deviceID")) {
      this.setPref("deviceID", Zotero.Utilities.randomString(16));
    }

    this.loadDeletions().catch((e) => Zotero.logError(e));

    this.observerID = Zotero.Notifier.registerObserver(
      { notify: (event, type, ids, extraData) => this.onNotify(event, type, ids, extraData) },
      ["item", "collection"],
      "lansync"
    );

    this.prefObservers.push(
      Zotero.Prefs.registerObserver("extensions.lansync.port", () => this.startServer(), true),
      Zotero.Prefs.registerObserver("extensions.lansync.autoSyncMinutes", () => this.scheduleAutoSync(), true)
    );

    Zotero.PreferencePanes.register({
      pluginID: id,
      src: rootURI + "preferences.xhtml",
      label: "Local Sync",
    });

    this.startServer();
    this.scheduleAutoSync();
    this.log(`started (v${version})`);
  },

  shutdown() {
    this.stopServer();
    if (this.timer) {
      this.timer.cancel();
      this.timer = null;
    }
    if (this.observerID) Zotero.Notifier.unregisterObserver(this.observerID);
    for (const sym of this.prefObservers) Zotero.Prefs.unregisterObserver(sym);
    this.prefObservers = [];
    for (const win of Zotero.getMainWindows()) this.removeFromWindow(win);
    this.pendingPlans.clear();
    delete Zotero.LanSync;
  },

  // ================================================================ UI

  addToWindow(win) {
    const doc = win.document;
    const popup = doc.getElementById("menu_ToolsPopup");
    if (!popup || this.windowElements.has(win)) return;
    const sep = doc.createXULElement("menuseparator");
    const sync = doc.createXULElement("menuitem");
    sync.id = "lansync-sync-now";
    sync.setAttribute("label", "Local Sync: Sync now");
    sync.addEventListener("command", () => this.syncNow());
    const review = doc.createXULElement("menuitem");
    review.id = "lansync-review";
    review.setAttribute("label", "Local Sync: Review changes…");
    review.addEventListener("command", () => this.reviewChanges());
    popup.appendChild(sep);
    popup.appendChild(sync);
    popup.appendChild(review);
    this.windowElements.set(win, [sep, sync, review]);
  },

  removeFromWindow(win) {
    const els = this.windowElements.get(win);
    if (!els) return;
    for (const el of els) el.remove();
    this.windowElements.delete(win);
  },

  initPrefPane(doc) {
    try {
      const self = doc.getElementById("lansync-self");
      if (self) {
        self.value = `This computer: ${this.hostName() || "(unknown hostname)"}, port ${this.getPort()}`
          + (this.server ? " (listening)" : " (server not running, check the port)");
      }
      const status = doc.getElementById("lansync-status");
      if (status) status.value = this.getPref("lastResult") || "Not synced yet.";
      this.updateLinkedFolderLabel(doc);
    } catch (e) {
      Zotero.logError(e);
    }
  },

  hostName() {
    try {
      return LS_Cc["@mozilla.org/network/dns-service;1"].getService(LS_Ci.nsIDNSService).myHostName;
    } catch (e) {
      return "";
    }
  },

  // This PC's LAN addresses, so you know what to type as the peer on the other PC.
  async localAddresses() {
    try {
      const dns = LS_Cc["@mozilla.org/network/dns-service;1"].getService(LS_Ci.nsIDNSService);
      const host = dns.myHostName;
      const record = await new Promise((resolve, reject) => {
        const listener = {
          QueryInterface: ChromeUtils.generateQI(["nsIDNSListener"]),
          onLookupComplete(req, rec, status) {
            if (Components.isSuccessCode(status)) resolve(rec);
            else reject(new Error("lookup failed"));
          },
        };
        const tm = LS_Cc["@mozilla.org/thread-manager;1"].getService(LS_Ci.nsIThreadManager);
        dns.asyncResolve(host, LS_Ci.nsIDNSService.RESOLVE_TYPE_DEFAULT, 0, null, listener, tm.mainThread, {});
      });
      const out = [];
      const rec = record.QueryInterface(LS_Ci.nsIDNSAddrRecord);
      while (rec.hasMore()) {
        const a = rec.getNextAddrAsString();
        if (/^(127\.|169\.254\.|::1$|fe80:)/i.test(a)) continue;
        if (!out.includes(a)) out.push(a);
      }
      return out;
    } catch (e) {
      return [];
    }
  },

  async testConnection(doc) {
    const out = doc && doc.getElementById("lansync-test");
    const say = (t) => {
      if (out) out.textContent = t;
      this.log("test: " + t.replace(/\n/g, " | "));
    };
    const lines = [];
    say("Testing…");

    // 1. Is this PC's own server running?
    const port = this.getPort();
    try {
      const info = await this.request("GET", `http://127.0.0.1:${port}/lansync/info`, undefined, { timeout: 5000 });
      lines.push(`✔ This PC is listening on port ${port} (plugin ${info.version}, ${info.server || "fallback"} server).`);
    } catch (e) {
      if (/HTTP 401/.test(e.message)) {
        lines.push(`✔ This PC is listening on port ${port}. (Set a shared token before syncing.)`);
      } else {
        lines.push(`✘ This PC's own Local Sync server isn't answering on port ${port}. Another program may be using that port: try another port number on both PCs, then restart Zotero.`);
      }
    }
    try {
      const echo = await this.request("POST", `http://127.0.0.1:${port}/lansync/echo`, { ping: "é✓" }, { timeout: 5000 });
      lines.push(echo.ok ? "✔ This PC answers POST requests too." : "✘ This PC's POST answer was wrong.");
    } catch (e) {
      lines.push("✘ This PC's server fails on POST requests: " + e.message);
    }
    const addrs = await this.localAddresses();
    if (addrs.length) lines.push(`   This PC's address${addrs.length > 1 ? "es" : ""}: ${addrs.map((a) => a + ":" + port).join(", ")}  ← enter one of these as the peer on the other PC.`);

    // 2. Can we reach the other PC?
    const peer = (this.getPref("peer") || "").trim();
    if (!peer) {
      lines.push("✘ No peer address set.");
      say(lines.join("\n"));
      return;
    }
    const { host, port: peerPort } = this.parsePeer(peer);
    try {
      const info = await this.request("GET", this.baseURL(host, peerPort) + "/info", undefined, { timeout: 10000 });
      if (info.deviceID === this.getPref("deviceID")) {
        lines.push(`✘ ${peer} is this same PC. Enter the OTHER PC's address.`);
      } else if (info.protocol !== LS_PROTOCOL) {
        lines.push(`✘ Reached ${info.name || host}, but it runs a different plugin version (${info.version}). Install the same version on both PCs.`);
      } else {
        lines.push(`✔ Reached ${info.name || host} at ${host}:${peerPort} (plugin ${info.version}, ${info.server || "old"} server), and the tokens match.`);
        try {
          const echo = await this.request("POST", this.baseURL(host, peerPort) + "/echo", { ping: "é✓" }, { timeout: 10000 });
          lines.push(echo.ok ? "✔ It answers POST requests too." : "✘ Its POST answer was wrong.");
        } catch (e2) {
          lines.push("✘ It fails on POST requests: " + e2.message);
        }
        try {
          const t0 = Date.now();
          const ch = await this.request("POST", this.baseURL(host, peerPort) + "/changes", { sinceByLib: {} }, { timeout: 10 * 60 * 1000 });
          lines.push(`✔ It sent its full change list: ${ch.items.length} items, ${ch.collections.length} collections, ${ch.files.length} files, ${ch.libs.length} libraries (${Math.round((Date.now() - t0) / 1000)} s). Ready to sync.`);
        } catch (e3) {
          lines.push("✘ It failed while sending its change list: " + e3.message);
        }
      }
    } catch (e) {
      if (/HTTP 401/.test(e.message)) {
        lines.push(`✘ Reached ${host}:${peerPort}, but the shared tokens don't match. Copy the token from one PC to the other exactly.`);
      } else {
        lines.push("✘ " + e.message);
      }
    }
    say(lines.join("\n"));
  },

  // ================================================================ linked file paths

  /*
   * Linked files saved with full paths from another computer (e.g. "G:\My Drive\zotero\paper_pdfs\X.pdf")
   * don't open anywhere else. Rewrite them relative to this PC's linked-files folder
   * ("attachments:paper_pdfs/X.pdf") and make that folder Zotero's base directory here.
   * Relative paths then work on every PC that has its own copy of the folder (e.g. via Google Drive).
   */
  async fixLinkedPaths(doc) {
    const out = doc && doc.getElementById("lansync-linked-status");
    const say = (t) => {
      if (out) out.textContent = t;
      this.log("linked paths: " + t.replace(/\n/g, " | "));
    };
    try {
      const { FilePicker } = ChromeUtils.importESModule("chrome://zotero/content/modules/filePicker.mjs");
      const fp = new FilePicker();
      const current = Zotero.Prefs.get("baseAttachmentPath");
      if (current) fp.displayDirectory = current;
      fp.init(
        doc ? doc.defaultView : Zotero.getMainWindow(),
        "Choose THIS PC's linked files folder (the folder that holds, or should hold, your linked PDFs)",
        fp.modeGetFolder
      );
      if ((await fp.show()) != fp.returnOK) return;
      const folder = PathUtils.normalize(fp.file);

      say("Scanning linked files…");
      const scan = await this.scanLinkedPaths(folder);
      const lines = [
        `Folder on this PC: ${folder}`,
        "",
        `${scan.plan.length} linked file${scan.plan.length === 1 ? "" : "s"} will be set to this folder:`,
        `   • ${scan.found} found there now`,
        `   • ${scan.notFound} not in this folder yet; Local Sync will copy them over from the other PC when you sync`,
        `${scan.already} already use the folder (nothing to change).`,
      ];
      if (scan.unmatched.length) {
        lines.push(`${scan.unmatched.length} couldn't be matched to this folder and stay as they are, e.g.:`);
        for (const p of scan.unmatched.slice(0, 3)) lines.push("   " + p);
      }
      lines.push("", "A backup of the old paths is saved in your Zotero data folder first.");

      if (!scan.plan.length) {
        say(lines.join("\n") + "\n\nNothing to change.");
        if (!current || current !== folder) {
          Zotero.Prefs.set("baseAttachmentPath", folder);
          Zotero.Prefs.set("saveRelativeAttachmentPath", true);
        }
        this.updateLinkedFolderLabel(doc);
        return;
      }
      const ok = Services.prompt.confirm(doc ? doc.defaultView : null, "Fix linked file paths", lines.join("\n"));
      if (!ok) {
        say("Cancelled. Nothing was changed.");
        return;
      }

      say(`Updating ${scan.plan.length} linked files…`);
      const backup = PathUtils.join(Zotero.DataDirectory.dir, `lansync-linked-paths-backup-${Date.now()}.json`);
      await IOUtils.writeJSON(backup, scan.plan.map((p) => ({ itemID: p.id, key: p.key, oldPath: p.oldPath, newPath: p.newPath })));

      // Same steps as Zotero's own "Linked Attachment Base Directory" setting
      Zotero.Prefs.set("baseAttachmentPath", folder);
      Zotero.Prefs.set("saveRelativeAttachmentPath", true);
      let done = 0;
      const errors = [];
      for (let i = 0; i < scan.plan.length; i += 100) {
        const chunk = scan.plan.slice(i, i + 100);
        await Zotero.DB.executeTransaction(async () => {
          for (const p of chunk) {
            try {
              const item = Zotero.Items.get(p.id);
              if (!item) continue;
              item.attachmentPath = p.newPath;
              await item.save({ skipDateModifiedUpdate: true, skipSelect: true });
              done++;
            } catch (e) {
              errors.push(`${p.oldPath}: ${e.message || e}`);
            }
          }
        });
      }
      this.updateLinkedFolderLabel(doc);
      say(
        `Done: ${done} linked file${done === 1 ? "" : "s"} now point to ${folder}.`
          + (errors.length ? `\n${errors.length} failed, e.g. ${errors[0]}` : "")
          + `\nBackup of the old paths: ${backup}`
          + "\n\nDo the same on the other PC, choosing ITS copy of the folder, then sync."
      );
    } catch (e) {
      Zotero.logError(e);
      say("Failed: " + ((e && e.message) || e));
    }
  },

  async scanLinkedPaths(folder) {
    const rows = (await Zotero.DB.queryAsync(
      "SELECT IA.itemID AS id, I.key AS key, IA.path AS path FROM itemAttachments IA JOIN items I USING (itemID) "
        + "WHERE IA.linkMode=2 AND IA.path IS NOT NULL AND IA.path != ''"
    )) || [];
    const anchor = PathUtils.filename(folder).toLowerCase();
    const result = { plan: [], found: 0, notFound: 0, already: 0, unmatched: [] };
    let index = null;
    const exists = async (p) => {
      try {
        return (await IOUtils.stat(p)).type === "regular";
      } catch (e) {
        return false;
      }
    };

    for (const row of rows) {
      const path = row.path;
      if (path.startsWith("attachments:")) {
        result.already++;
        continue;
      }
      const segs = path.split(/[\\/]+/).filter(Boolean);
      const fileName = segs[segs.length - 1] || "";
      let rel = null;

      // A. Already a real path inside the chosen folder on this PC
      if (this.isAbsoluteHere(path)) {
        try {
          if (Zotero.File.directoryContains(folder, path)) {
            const base = PathUtils.normalize(folder).replace(/\\/g, "/").replace(/\/?$/, "/");
            rel = PathUtils.normalize(path).replace(/\\/g, "/").substr(base.length).split("/").filter(Boolean);
          }
        } catch (e) {}
      }
      // B. Find the folder's name in the old path: ".../zotero/paper_pdfs/X.pdf" -> paper_pdfs/X.pdf
      if (!rel) {
        for (let k = segs.length - 2; k >= 0; k--) {
          if (segs[k].toLowerCase() === anchor) {
            rel = segs.slice(k + 1);
            break;
          }
        }
      }
      let found = rel ? await exists(PathUtils.join(folder, ...rel)) : false;
      // C. Not found that way: look for a single file with the same name anywhere in the folder
      if (!found && fileName) {
        if (!index) index = await this.buildFileIndex(folder);
        const matches = index.get(fileName.toLowerCase());
        if (matches && matches.length === 1) {
          rel = matches[0];
          found = true;
        }
      }
      if (!rel || !rel.length || rel.some((s) => s === "." || s === "..")) {
        result.unmatched.push(path);
        continue;
      }
      if (found) result.found++;
      else result.notFound++;
      result.plan.push({ id: row.id, key: row.key, oldPath: path, newPath: "attachments:" + rel.join("/") });
    }
    return result;
  },

  // file name (lowercase) -> list of relative paths (as segment arrays) inside the folder
  async buildFileIndex(folder) {
    const index = new Map();
    let count = 0;
    const walk = async (dir, rel, depth) => {
      if (depth > 12 || count > 300000) return;
      let children = [];
      try {
        children = await IOUtils.getChildren(dir);
      } catch (e) {
        return;
      }
      for (const child of children) {
        const name = PathUtils.filename(child);
        let st;
        try {
          st = await IOUtils.stat(child);
        } catch (e) {
          continue;
        }
        if (st.type === "directory") {
          await walk(child, rel.concat(name), depth + 1);
        } else if (st.type === "regular") {
          count++;
          const k = name.toLowerCase();
          if (!index.has(k)) index.set(k, []);
          index.get(k).push(rel.concat(name));
        }
      }
    };
    await walk(folder, [], 0);
    return index;
  },

  updateLinkedFolderLabel(doc) {
    const el = doc && doc.getElementById("lansync-linked-folder");
    if (!el) return;
    const base = Zotero.Prefs.get("baseAttachmentPath");
    const on = Zotero.Prefs.get("saveRelativeAttachmentPath");
    el.value = base && on ? `Linked files folder on this PC: ${base}` : "Linked files folder on this PC: not set";
  },

  generateToken(doc) {
    const token = Zotero.Utilities.randomString(32);
    this.setPref("token", token);
    const input = doc && doc.getElementById("lansync-token");
    if (input) input.value = token;
  },

  resetState(doc) {
    this.setPref("state", "{}");
    this.setPref("lastResult", "Sync state reset. The next sync will compare the full library.");
    if (doc) this.initPrefPane(doc);
  },

  notify(message, isError = false) {
    try {
      const pw = new Zotero.ProgressWindow({ closeOnClick: true });
      pw.changeHeadline(isError ? "Local Sync: error" : "Local Sync");
      pw.addDescription(message);
      pw.show();
      pw.startCloseTimer(isError ? 8000 : 4000);
    } catch (e) {
      this.log(message);
    }
  },

  // ================================================================ prefs/state

  getPref(name) {
    return Zotero.Prefs.get("extensions.lansync." + name, true);
  },

  setPref(name, value) {
    Zotero.Prefs.set("extensions.lansync." + name, value, true);
  },

  getPort() {
    return parseInt(this.getPref("port")) || 23120;
  },

  getState() {
    try {
      const s = JSON.parse(this.getPref("state") || "{}");
      s.lastPulled = s.lastPulled || {};
      return s;
    } catch (e) {
      return { lastPulled: {} };
    }
  },

  setState(state) {
    this.setPref("state", JSON.stringify(state));
  },

  // Watermarks are { libKey: sqlDate }. Version 0.1 stored a single string for My Library.
  normalizeWatermark(v) {
    if (typeof v === "string") return { u: v };
    if (v && typeof v === "object") return Object.assign({}, v);
    return {};
  },

  advanceWatermark(deviceID, changes, failedLibs, incompleteLibs) {
    const state = this.getState();
    const lp = this.normalizeWatermark(state.lastPulled[deviceID]);
    for (const lib of changes.libs || []) {
      if (failedLibs.has(lib) || incompleteLibs.has(lib)) continue;
      if (!this.libIDFor(lib)) continue; // library not on this PC (yet): keep it at "full" next time
      lp[lib] = changes.now;
    }
    state.lastPulled[deviceID] = lp;
    this.setState(state);
  },

  log(msg) {
    Zotero.debug("[LocalSync] " + msg);
  },

  // ================================================================ libraries

  syncGroupsEnabled() {
    return this.getPref("syncGroups") !== false;
  },

  syncLinkedEnabled() {
    return this.getPref("syncLinkedFiles") !== false;
  },

  libKeyFor(libraryID) {
    if (libraryID === Zotero.Libraries.userLibraryID) return "u";
    try {
      const gid = Zotero.Groups.getGroupIDFromLibraryID(libraryID);
      return gid ? "g" + gid : null;
    } catch (e) {
      return null; // feeds and other non-group libraries
    }
  },

  libIDFor(libKey) {
    if (libKey === "u") return Zotero.Libraries.userLibraryID;
    const m = /^g(\d+)$/.exec(libKey || "");
    if (!m) return false;
    try {
      return Zotero.Groups.getLibraryIDFromGroupID(parseInt(m[1])) || false;
    } catch (e) {
      return false;
    }
  },

  libName(libKey, remoteGroups) {
    if (libKey === "u") return "My Library";
    const m = /^g(\d+)$/.exec(libKey || "");
    if (!m) return libKey;
    try {
      const g = Zotero.Groups.get(parseInt(m[1]));
      if (g) return g.name;
    } catch (e) {}
    if (remoteGroups && remoteGroups[libKey]) return remoteGroups[libKey].name;
    return "Group " + m[1];
  },

  syncedLibs() {
    const libs = [{ key: "u", libraryID: Zotero.Libraries.userLibraryID, group: null }];
    if (this.syncGroupsEnabled()) {
      for (const g of Zotero.Groups.getAll()) {
        libs.push({ key: "g" + g.id, libraryID: g.libraryID, group: g });
      }
    }
    return libs;
  },

  // ================================================================ deletion log

  deletionsPath() {
    return PathUtils.join(Zotero.DataDirectory.dir, "lansync-deletions.json");
  },

  async loadDeletions() {
    try {
      const data = await IOUtils.readJSON(this.deletionsPath());
      if (Array.isArray(data)) this.deletions = data.concat(this.deletions);
    } catch (e) {
      // No file yet
    }
  },

  saveDeletions() {
    const cutoff = this.shiftSQL(this.sqlNow(), -LS_DELETION_RETENTION_DAYS * 86400);
    this.deletions = this.deletions.filter((d) => d.date >= cutoff);
    const snapshot = this.deletions.slice();
    this._saveChain = this._saveChain
      .then(() => IOUtils.writeJSON(this.deletionsPath(), snapshot))
      .catch((e) => Zotero.logError(e));
  },

  onNotify(event, type, ids, extraData) {
    if (event !== "delete") return;
    let added = false;
    for (const id of ids) {
      const x = extraData && extraData[id];
      if (!x || !x.key) continue;
      const lib = this.libKeyFor(x.libraryID);
      if (!lib) continue;
      this.deletions.push({ type, lib, key: x.key, date: this.sqlNow() });
      added = true;
    }
    if (added) this.saveDeletions();
  },

  // ================================================================ small helpers

  sqlNow() {
    return Zotero.Date.dateToSQL(new Date(), true);
  },

  shiftSQL(sql, seconds) {
    const d = Zotero.Date.sqlToDate(sql, true);
    return Zotero.Date.dateToSQL(new Date(d.getTime() + seconds * 1000), true);
  },

  bytesToBinary(b) {
    let s = "";
    for (let i = 0; i < b.length; i += 0x8000) {
      s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
    }
    return s;
  },

  binaryToBytes(s) {
    const b = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff;
    return b;
  },

  utf8Encode(str) {
    try {
      return new TextEncoder().encode(str);
    } catch (e) {}
    // Fallback that never throws (broken emoji / lone surrogates become U+FFFD)
    const out = new Uint8Array(str.length * 3);
    let o = 0;
    for (let i = 0; i < str.length; i++) {
      let c = str.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
        const d = str.charCodeAt(i + 1);
        if (d >= 0xdc00 && d <= 0xdfff) {
          c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
          i++;
        } else c = 0xfffd;
      } else if (c >= 0xd800 && c <= 0xdfff) c = 0xfffd;
      if (c < 0x80) out[o++] = c;
      else if (c < 0x800) {
        out[o++] = 0xc0 | (c >> 6);
        out[o++] = 0x80 | (c & 63);
      } else if (c < 0x10000) {
        out[o++] = 0xe0 | (c >> 12);
        out[o++] = 0x80 | ((c >> 6) & 63);
        out[o++] = 0x80 | (c & 63);
      } else {
        out[o++] = 0xf0 | (c >> 18);
        out[o++] = 0x80 | ((c >> 12) & 63);
        out[o++] = 0x80 | ((c >> 6) & 63);
        out[o++] = 0x80 | (c & 63);
      }
    }
    return out.subarray(0, o);
  },

  utf8Decode(bytes) {
    try {
      return new TextDecoder().decode(bytes);
    } catch (e) {}
    try {
      return decodeURIComponent(escape(this.bytesToBinary(bytes)));
    } catch (e) {
      return this.bytesToBinary(bytes);
    }
  },

  concatBytes(chunks, total) {
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      const n = Math.min(c.length, total - off);
      out.set(n === c.length ? c : c.subarray(0, n), off);
      off += n;
      if (off >= total) break;
    }
    return out;
  },

  formatSize(n) {
    if (!n && n !== 0) return "";
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(0) + " KB";
    if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + " MB";
    return (n / 1024 / 1024 / 1024).toFixed(2) + " GB";
  },

  snippet(html) {
    if (!html) return "";
    return String(html)
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, "&")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120);
  },

  itemLabel(j) {
    if (!j) return "";
    if (j.itemType === "note") return this.snippet(j.note) || "(empty note)";
    if (j.itemType === "annotation") {
      return this.snippet(j.annotationText || j.annotationComment) || `(${j.annotationType || "annotation"})`;
    }
    return j.title || j.filename || j.caseName || j.subject || j.nameOfAct || "(untitled)";
  },

  typeLabel(itemType) {
    try {
      return Zotero.ItemTypes.getLocalizedString(itemType) || itemType;
    } catch (e) {
      return itemType;
    }
  },

  parentTitle(lib, parentKey, incoming) {
    if (!parentKey) return "";
    const j = incoming.get(lib + ":" + parentKey);
    if (j) return this.itemLabel(j);
    const libID = this.libIDFor(lib);
    const it = libID && Zotero.Items.getByLibraryAndKey(libID, parentKey);
    try {
      return it ? it.getDisplayTitle() : "";
    } catch (e) {
      return "";
    }
  },

  // Stable string of the parts of an item that matter, for "is it actually different?"
  canonicalItem(j) {
    const c = Object.assign({}, j);
    delete c.version;
    delete c.key;
    if (Array.isArray(c.collections)) c.collections = c.collections.slice().sort();
    if (Array.isArray(c.tags)) c.tags = c.tags.map((t) => (t.type ? t.tag + "\u0001" + t.type : t.tag)).sort();
    if (c.relations && typeof c.relations === "object") {
      const r = {};
      for (const k of Object.keys(c.relations).sort()) {
        const v = c.relations[k];
        r[k] = (Array.isArray(v) ? v.slice() : [v]).sort();
      }
      c.relations = r;
    }
    const o = {};
    for (const k of Object.keys(c).sort()) {
      const v = c[k];
      if (v === "" || v === undefined || v === null || v === false) continue;
      if (Array.isArray(v) && !v.length) continue;
      if (v && typeof v === "object" && !Array.isArray(v) && !Object.keys(v).length) continue;
      o[k] = v;
    }
    return JSON.stringify(o);
  },

  itemRank(j) {
    if (j.itemType === "attachment" && j.linkMode === "embedded_image") return 3;
    if (j.itemType === "annotation") return 2;
    return j.parentItem ? 1 : 0;
  },

  // ================================================================ attachment paths

  isAbsoluteHere(p) {
    if (!p) return false;
    if (Zotero.isWin) return /^[A-Za-z]:[\\/]/.test(p) || /^\\\\[^\\]/.test(p);
    return p.startsWith("/");
  },

  // Where this attachment's file lives (or should live) on THIS computer.
  resolveAttachmentPath(key, linkMode, path) {
    if (!path || !/^[A-Z0-9]{8}$/.test(key)) return null;
    if (path.startsWith("storage:")) {
      const name = path.substr(8);
      if (!name || /[\\/]/.test(name) || name === "." || name === "..") return null;
      return PathUtils.join(Zotero.DataDirectory.dir, "storage", key, name);
    }
    if (linkMode !== 2) return null;
    if (path.startsWith("attachments:")) {
      const base = Zotero.Prefs.get("baseAttachmentPath");
      if (!base) return null;
      const parts = path.substr(12).split(/[\\/]+/).filter(Boolean);
      if (!parts.length || parts.some((p) => p === ".." || p === ".")) return null;
      try {
        return PathUtils.join(base, ...parts);
      } catch (e) {
        return null;
      }
    }
    return this.isAbsoluteHere(path) ? path : null;
  },

  // A file name from a Mac/Linux PC may not be allowed on Windows (e.g. "Notes: draft?.pdf").
  // Returns the offending name part, or null if every part is fine here.
  invalidNameHere(path) {
    if (!Zotero.isWin || !path) return null;
    let parts;
    if (path.startsWith("storage:")) parts = [path.substr(8)];
    else if (path.startsWith("attachments:")) parts = path.substr(12).split(/[\\/]+/).filter(Boolean);
    else return null; // absolute paths here came from this kind of computer already
    for (const p of parts) {
      if (/[<>:"|?*\u0000-\u001f]/.test(p) || /[. ]$/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(p)) {
        return p;
      }
    }
    return null;
  },

  linkedReason(path) {
    if (path && path.startsWith("attachments:")) {
      return "Set a Linked Attachment Base Directory on this PC (Settings → Advanced → Files and Folders)";
    }
    return "Linked to a location that doesn't exist on this kind of computer: " + path;
  },

  // ================================================================ HTTP server

  startServer(retry = true) {
    this.stopServer();
    const port = this.getPort();

    // Preferred: Firefox's built-in web server (the same one Zotero's own server uses),
    // listening on all network interfaces.
    try {
      const { HttpServer } = ChromeUtils.importESModule("chrome://remote/content/server/httpd.sys.mjs");
      const srv = new HttpServer();
      srv.registerPrefixHandler("/lansync/", (request, response) => this.onHttpdRequest(request, response));
      srv._start(port, "0.0.0.0"); // not "localhost": accept connections from the LAN
      // It only accepts requests addressed to host names it knows. Requests arrive addressed to this
      // PC's LAN IP or name (which can change), and the shared token is the real check, so accept any.
      srv.identity.getScheme = () => "http";
      srv.identity.has = () => true;
      this.httpd = srv;
      this.server = srv;
      this.log(`listening on port ${port} (all network interfaces, built-in web server)`);
      return;
    } catch (e) {
      this.httpd = null;
      this.server = null;
      if (/NS_ERROR_SOCKET_ADDRESS_IN_USE|ADDRESS_IN_USE/.test(String(e)) && retry) {
        // The previous server may still be shutting down; try again shortly.
        this.log(`port ${port} busy, retrying in 2 s`);
        Zotero.Promise.delay(2000).then(() => this.startServer(false));
        return;
      }
      this.log(`built-in web server unavailable (${e}); using the fallback server`);
    }

    // Fallback for Zotero versions without the built-in web server
    try {
      const srv = LS_Cc["@mozilla.org/network/server-socket;1"].createInstance(LS_Ci.nsIServerSocket);
      srv.init(port, false, -1); // false = listen on all interfaces, not only loopback
      srv.asyncListen({
        onSocketAccepted: (sock, transport) => this.onConnection(transport),
        onStopListening: () => {},
      });
      this.server = srv;
      this.log(`listening on port ${port} (fallback server)`);
    } catch (e) {
      this.server = null;
      this.log("could not start server on port " + port + ": " + e);
      Zotero.logError(e);
    }
  },

  stopServer() {
    for (const t of this.connections.keys()) {
      try {
        t.close(0);
      } catch (e) {}
    }
    this.connections.clear();
    if (this.httpd) {
      try {
        this.httpd.stop(() => {});
      } catch (e) {}
      this.httpd = null;
      this.server = null;
      return;
    }
    if (this.server) {
      try {
        this.server.close();
      } catch (e) {}
      this.server = null;
    }
  },

  // Request handler for the built-in web server. It has already read the whole request, body included.
  onHttpdRequest(request, response) {
    response.seizePower(); // we write the raw HTTP reply ourselves, asynchronously (as Zotero's server does)
    let remoteHost = "";
    try {
      remoteHost = String(response._connection.transport.host || "").replace(/^::ffff:/i, "");
    } catch (e) {}

    let done = false;
    const finish = (res) => {
      if (done) return;
      done = true;
      try {
        let bytes;
        try {
          bytes = this.buildResponseBytes(res);
        } catch (e) {
          this.log(`server: couldn't build the reply: ${(e && e.stack) || e}`);
          const msg = String((e && e.message) || e).replace(/[^\x20-\x7e]/g, "?");
          bytes = this.buildResponseBytes({ status: 500, json: { error: `The other PC couldn't build its reply: ${msg}` } });
        }
        this.log(`server: sending ${res.status} reply, ${bytes.length} bytes`);
        this.writeBytes(response.bodyOutputStream, bytes);
      } catch (e) {
        this.log(`server: sending the reply failed: ${(e && e.stack) || e}`);
        Zotero.logError(e);
      } finally {
        try {
          response.finish();
        } catch (e) {}
      }
    };

    try {
      const headers = {};
      for (const h of request.headers) {
        const name = h.QueryInterface ? h.QueryInterface(LS_Ci.nsISupportsString).data : h.data;
        headers[name.toLowerCase()] = request.getHeader(name);
      }
      const token = this.getPref("token");
      if (!token || headers["x-lansync-token"] !== token) {
        finish({ status: 401, json: { error: "Missing or wrong token. Both PCs must use the same shared token." } });
        return;
      }

      let body = new Uint8Array(0);
      const bis = request.bodyInputStream;
      const n = bis ? bis.available() : 0;
      if (n > 0) {
        try {
          body = new Uint8Array(LS_NetUtil.readInputStream(bis, n));
        } catch (e) {
          body = this.binaryToBytes(LS_NetUtil.readInputStreamToString(bis, n));
        }
      }
      const req = {
        method: request.method,
        path: request.path + (request.queryString ? "?" + request.queryString : ""),
        headers,
        length: body.length,
        body,
      };
      const started = Date.now();
      this.log(`server: ${req.method} ${req.path} from ${remoteHost} (${req.length} bytes)`);

      Promise.resolve()
        .then(() => this.handleRequest(req, remoteHost))
        .catch((e) => {
          this.log(`server: ${req.method} ${req.path} failed: ${(e && e.stack) || e}`);
          Zotero.logError(e);
          return { status: 500, json: { error: `The other PC hit an error: ${(e && e.message) || e}` } };
        })
        .then((res) => {
          this.log(`server: ${req.method} ${req.path} -> ${res.status} in ${Date.now() - started} ms`);
          finish(res);
        });
    } catch (e) {
      this.log(`server: error while reading the request: ${(e && e.stack) || e}`);
      Zotero.logError(e);
      finish({ status: 500, json: { error: `The other PC couldn't read the request: ${(e && e.message) || e}` } });
    }
  },

  // Write bytes to a (non-blocking or unbounded) output stream in chunks.
  writeBytes(out, bytes) {
    const CHUNK = 0x10000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      const s = this.bytesToBinary(bytes.subarray(i, i + CHUNK));
      let written = 0;
      while (written < s.length) {
        written += out.write(written ? s.slice(written) : s, s.length - written);
      }
    }
  },

  onConnection(transport) {
    const input = transport.openInputStream(0, 0, 0);
    const output = transport.openOutputStream(0, 0, 0);
    const bin = LS_Cc["@mozilla.org/binaryinputstream;1"].createInstance(LS_Ci.nsIBinaryInputStream);
    bin.setInputStream(input);
    const pump = LS_Cc["@mozilla.org/network/input-stream-pump;1"].createInstance(LS_Ci.nsIInputStreamPump);

    const remoteHost = String(transport.host || "").replace(/^::ffff:/i, "");
    const conn = { transport, input, output, bin, pump, listener: null };
    this.connections.set(transport, conn); // strong reference until the reply is sent
    this.log(`server: connection from ${remoteHost}`);
    let totalBytes = 0;
    let chunkCount = 0;

    let head = new Uint8Array(0);
    let req = null;
    let chunks = [];
    let got = 0;
    let handled = false;

    const readChunk = (count) => {
      if (typeof bin.readArrayBuffer === "function") {
        const ab = new ArrayBuffer(count);
        const n = bin.readArrayBuffer(count, ab);
        return new Uint8Array(ab, 0, n);
      }
      return new Uint8Array(bin.readByteArray(count));
    };
    const reply = (res) => {
      handled = true;
      this.sendResponse(transport, output, res);
    };

    const onData = (count) => {
      const chunk = readChunk(count);
      totalBytes += chunk.length;
      chunkCount++;
      if (chunkCount <= 5 || chunkCount % 200 === 0) {
        this.log(`server: received ${chunk.length} bytes from ${remoteHost} (total ${totalBytes}${req ? `, body ${got + chunk.length}/${req.length}` : ", reading headers"})`);
      }
      if (handled) return;

      if (!req) {
        const merged = new Uint8Array(head.length + chunk.length);
        merged.set(head);
        merged.set(chunk, head.length);
        head = merged;
        const parsed = this.parseHead(head); // throws on bad headers
        if (!parsed) return; // headers incomplete
        req = parsed;
        this.log(`server: headers: ${req.method} ${req.path}, Content-Length ${req.length}${req.headers["transfer-encoding"] ? ", Transfer-Encoding " + req.headers["transfer-encoding"] : ""}${req.headers["expect"] ? ", Expect " + req.headers["expect"] : ""}`);
        // Check the token before accepting a (possibly large) body
        const token = this.getPref("token");
        if (!token || req.headers["x-lansync-token"] !== token) {
          reply({ status: 401, json: { error: "Missing or wrong token. Both PCs must use the same shared token." } });
          return;
        }
        const rest = head.subarray(req.bodyStart);
        chunks = [rest];
        got = rest.length;
        head = null;
      } else {
        chunks.push(chunk);
        got += chunk.length;
      }

      if (got < req.length) return;
      handled = true;
      req.body = this.concatBytes(chunks, req.length);
      chunks = null;
      const started = Date.now();
      this.log(`server: ${req.method} ${req.path} from ${remoteHost} (${req.length} bytes)`);

      Promise.resolve()
        .then(() => this.handleRequest(req, remoteHost))
        .catch((e) => {
          this.log(`server: ${req.method} ${req.path} failed: ${(e && e.stack) || e}`);
          Zotero.logError(e);
          return { status: 500, json: { error: `The other PC hit an error: ${(e && e.message) || e}` } };
        })
        .then((res) => {
          this.log(`server: ${req.method} ${req.path} -> ${res.status} in ${Date.now() - started} ms`);
          this.sendResponse(transport, output, res);
        });
    };

    conn.listener = {
      QueryInterface: ChromeUtils.generateQI(["nsIStreamListener", "nsIRequestObserver"]),
      onStartRequest() {},
      onStopRequest: (request, status) => {
        this.log(`server: input from ${remoteHost} ended (0x${(status >>> 0).toString(16)}) after ${totalBytes} bytes; request ${handled ? "was complete" : "was NOT complete"}`);
        if (!handled) {
          this.connections.delete(transport); // client went away before sending a full request
        }
      },
      onDataAvailable: (request, stream, offset, count) => {
        try {
          onData(count);
        } catch (e) {
          this.log(`server: error while reading the request: ${(e && e.stack) || e}`);
          Zotero.logError(e);
          if (!handled) reply({ status: 500, json: { error: `The other PC couldn't read the request: ${(e && e.message) || e}` } });
        }
      },
    };
    pump.init(input, 0, 0, false);
    pump.asyncRead(conn.listener);
  },

  // Keep each open connection referenced until it's closed, so nothing gets garbage-collected mid-request.
  connections: new Map(),

  sendResponse(transport, output, res) {
    try {
      this._sendResponse(transport, output, res);
    } catch (e) {
      this.log(`server: couldn't send the reply: ${(e && e.stack) || e}`);
      Zotero.logError(e);
      try {
        // Fall back to a small plain-ASCII error reply
        const msg = String((e && e.message) || e).replace(/[^\x20-\x7e]/g, "?");
        this._sendResponse(transport, output, { status: 500, json: { error: `The other PC couldn't send its reply: ${msg}` } });
      } catch (e2) {
        this.log(`server: fallback reply failed too: ${e2}`);
        try {
          transport.close(0);
        } catch (e3) {}
        this.connections.delete(transport);
      }
    }
  },

  parseHead(b) {
    let end = -1;
    for (let i = 0; i + 3 < b.length; i++) {
      if (b[i] === 13 && b[i + 1] === 10 && b[i + 2] === 13 && b[i + 3] === 10) {
        end = i;
        break;
      }
    }
    if (end === -1) {
      if (b.length > 65536) throw new Error("Headers too large");
      return null;
    }
    const lines = this.bytesToBinary(b.subarray(0, end)).split("\r\n");
    const [method, path] = lines[0].split(" ");
    const headers = {};
    for (const line of lines.slice(1)) {
      const idx = line.indexOf(":");
      if (idx > 0) headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
    }
    return { method, path, headers, length: parseInt(headers["content-length"] || "0") || 0, bodyStart: end + 4 };
  },

  buildResponseBytes(res) {
    let body;
    let type;
    if (res.bytes) {
      body = res.bytes;
      type = res.type || "application/octet-stream";
    } else {
      body = this.utf8Encode(JSON.stringify(res.json || {}));
      type = "application/json; charset=utf-8";
    }
    const head = this.binaryToBytes(
      `HTTP/1.1 ${res.status} ${LS_STATUS[res.status] || "OK"}\r\n`
        + `Content-Type: ${type}\r\n`
        + `Content-Length: ${body.length}\r\n`
        + "Connection: close\r\n\r\n"
    );
    const all = new Uint8Array(head.length + body.length);
    all.set(head);
    all.set(body, head.length);
    return all;
  },

  _sendResponse(transport, output, res) {
    const all = this.buildResponseBytes(res);
    this.log(`server: sending ${res.status} reply, ${all.length} bytes`);
    const stream = LS_Cc["@mozilla.org/io/arraybuffer-input-stream;1"].createInstance(LS_Ci.nsIArrayBufferInputStream);
    stream.setData(all.buffer, 0, all.length);
    LS_NetUtil.asyncCopy(stream, output, (status) => {
      this.log(`server: reply ${Components.isSuccessCode(status) ? "sent" : `FAILED (0x${(status >>> 0).toString(16)})`}, closing connection`);
      try {
        transport.close(0);
      } catch (e) {}
      this.connections.delete(transport);
    });
  },

  async handleRequest(req, remoteHost) {
    const url = (req.path || "").split("?")[0];
    const body = () => {
      try {
        return req.body.length ? JSON.parse(this.utf8Decode(req.body)) : {};
      } catch (e) {
        return {};
      }
    };

    if (req.method === "GET" && url === "/lansync/info") {
      const state = this.getState();
      const asker = req.headers["x-lansync-device"] || "";
      return {
        status: 200,
        json: {
          protocol: LS_PROTOCOL,
          deviceID: this.getPref("deviceID"),
          version: this.version,
          name: this.hostName(),
          server: this.httpd ? "built-in" : "fallback",
          now: this.sqlNow(),
          watermarkForYou: this.normalizeWatermark(state.lastPulled[asker]),
        },
      };
    }

    if (req.method === "POST" && url === "/lansync/echo") {
      return { status: 200, json: { ok: true, received: req.length, body: body() } };
    }

    if (req.method === "POST" && url === "/lansync/changes") {
      const b = body();
      const since = b.sinceByLib || (b.since ? { u: b.since } : {});
      return { status: 200, json: await this.getChanges(since) };
    }

    const fm = url.match(/^\/lansync\/file\/(u|g\d+)\/([A-Z0-9]{8})$/);
    if (req.method === "GET" && fm) {
      return this.serveFile(fm[1], fm[2]);
    }

    if (req.method === "POST" && url === "/lansync/preview") {
      const b = body();
      if (!b.changes || !b.deviceID || b.deviceID === this.getPref("deviceID")) {
        return { status: 400, json: { error: "Bad preview request" } };
      }
      const rows = await this.classifyChanges(b.changes);
      const back = await this.callbackAddress(b.deviceID, remoteHost, parseInt(b.port) || 23120);
      const planID = Zotero.Utilities.randomString(16);
      this.prunePlans();
      this.pendingPlans.set(planID, {
        changes: b.changes,
        rows,
        deviceID: b.deviceID,
        host: back.host,
        port: back.port,
        ts: Date.now(),
      });
      const warning = back.ok ? "" :
        `${this.hostName() || "The other PC"} couldn't connect back to this PC (tried ${back.tried.join(" and ")}), `
        + `so files from this PC can't be copied to ${this.hostName() || "it"} this time. `
        + `On ${this.hostName() || "the other PC"}, set the peer address to THIS PC's IP and click Test connection there.`;
      return { status: 200, json: { planID, rows, warning } };
    }

    if (req.method === "POST" && url === "/lansync/apply") {
      const b = body();
      const plan = this.pendingPlans.get(b.planID);
      if (!plan) return { status: 404, json: { error: "This preview has expired on the other PC. Run the sync again." } };
      if (this.syncing) return { status: 409, json: { error: "The other PC is busy syncing. Try again shortly." } };
      this.syncing = true;
      try {
        const res = await this.applyChanges(plan.changes, plan.rows, new Set(b.selected || []), this.baseURL(plan.host, plan.port));
        this.advanceWatermark(plan.deviceID, plan.changes, res.failedLibs, res.incompleteLibs);
        this.pendingPlans.delete(b.planID);
        this.setPref("lastResult", `${new Date().toLocaleString()}: received from ${plan.host}: ${this.summarize(res.stats)}`);
        return { status: 200, json: res.stats };
      } finally {
        this.syncing = false;
      }
    }

    return { status: 404, json: { error: "Not found" } };
  },

  /*
   * Which address to use when connecting BACK to the PC that started the sync (to fetch its files).
   * The address a connection appears to come from is wrong behind NAT / port forwarding
   * (Chromebook Linux, VMs, WSL, Docker): it's the gateway, where nothing listens.
   * So prefer the peer address typed in this PC's settings, after checking it really is that PC.
   */
  async callbackAddress(deviceID, remoteHost, remotePort) {
    const candidates = [];
    const peer = (this.getPref("peer") || "").trim();
    if (peer) candidates.push(this.parsePeer(peer));
    candidates.push({ host: remoteHost, port: remotePort });
    for (const c of candidates) {
      try {
        const info = await this.request("GET", this.baseURL(c.host, c.port) + "/info", undefined, { timeout: 5000 });
        if (info.deviceID === deviceID) {
          this.log(`will connect back to ${c.host}:${c.port}`);
          return Object.assign({ ok: true }, c);
        }
        this.log(`${c.host}:${c.port} is a different device, not using it to connect back`);
      } catch (e) {
        this.log(`can't connect back via ${c.host}:${c.port}: ${e.message}`);
      }
    }
    // Neither answered; keep the configured address so the error names something recognisable.
    return Object.assign({ ok: false, tried: candidates.map((c) => `${c.host}:${c.port}`) }, candidates[0]);
  },

  prunePlans() {
    const now = Date.now();
    for (const [id, p] of this.pendingPlans) {
      if (now - p.ts > LS_PLAN_TTL_MS) this.pendingPlans.delete(id);
    }
    while (this.pendingPlans.size >= 3) {
      this.pendingPlans.delete(this.pendingPlans.keys().next().value);
    }
  },

  // ================================================================ building a change set

  async getChanges(sinceByLib = {}) {
    const now = this.sqlNow();
    const out = { protocol: LS_PROTOCOL, now, libs: [], groups: [], collections: [], items: [], deletions: [], files: [] };
    const libs = this.syncedLibs();

    for (const lib of libs) {
      out.libs.push(lib.key);
      if (lib.group) {
        out.groups.push({
          groupID: lib.group.id,
          name: lib.group.name,
          description: lib.group.description || "",
          editable: !!lib.group.editable,
          filesEditable: !!lib.group.filesEditable,
        });
      }

      const since = sinceByLib[lib.key];
      const eff = since ? this.shiftSQL(since, -LS_WATERMARK_OVERLAP_SEC) : null;
      const cond = eff ? " AND clientDateModified >= ?" : "";
      const params = eff ? [lib.libraryID, eff] : [lib.libraryID];

      const collRows = (await Zotero.DB.queryAsync(
        "SELECT collectionID AS id, clientDateModified AS mod FROM collections WHERE libraryID=?" + cond, params
      )) || [];
      if (collRows.length) {
        const mods = new Map(collRows.map((r) => [r.id, r.mod]));
        const objs = await Zotero.Collections.getAsync(collRows.map((r) => r.id));
        await Zotero.Collections.loadDataTypes(objs);
        for (const c of objs) out.collections.push({ lib: lib.key, mod: mods.get(c.id), json: c.toJSON() });
      }

      const itemRows = (await Zotero.DB.queryAsync(
        "SELECT itemID AS id, clientDateModified AS mod FROM items WHERE libraryID=?" + cond, params
      )) || [];
      if (itemRows.length) {
        const mods = new Map(itemRows.map((r) => [r.id, r.mod]));
        const objs = await Zotero.Items.getAsync(itemRows.map((r) => r.id));
        await Zotero.Items.loadDataTypes(objs);
        const entries = [];
        for (const item of objs) {
          try {
            entries.push({ lib: lib.key, mod: mods.get(item.id), json: item.toJSON() });
          } catch (e) {
            this.log(`skipping item ${item.key}: ${e}`);
          }
        }
        entries.sort((a, b) => this.itemRank(a.json) - this.itemRank(b.json));
        for (const e of entries) out.items.push(e);
      }

      for (const d of this.deletions) {
        const dl = d.lib || "u";
        if (dl === lib.key && (!eff || d.date >= eff)) out.deletions.push({ type: d.type, lib: dl, key: d.key, date: d.date });
      }
    }

    out.files = await this.listFiles(libs);
    return out;
  },

  async listFiles(libs) {
    const syncLinked = this.syncLinkedEnabled();
    const out = [];
    for (const lib of libs) {
      const rows = (await Zotero.DB.queryAsync(
        "SELECT I.key AS key, IA.linkMode AS linkMode, IA.path AS path FROM itemAttachments IA JOIN items I USING (itemID) "
          + "WHERE I.libraryID=? AND IA.linkMode IN (0,1,2,4) AND IA.path IS NOT NULL AND IA.path != ''",
        [lib.libraryID]
      )) || [];
      for (const row of rows) {
        if (row.linkMode === 2 && !syncLinked) continue;
        const p = this.resolveAttachmentPath(row.key, row.linkMode, row.path);
        if (!p) continue;
        try {
          const st = await IOUtils.stat(p);
          if (st.type !== "regular") continue;
          out.push({
            lib: lib.key,
            key: row.key,
            size: st.size,
            mtime: st.lastModified,
            linked: row.linkMode === 2,
            name: PathUtils.filename(p),
          });
        } catch (e) {
          // File missing on this machine
        }
      }
    }
    return out;
  },

  async serveFile(libKey, key) {
    const libID = this.libIDFor(libKey);
    const item = libID && Zotero.Items.getByLibraryAndKey(libID, key);
    if (!item || !item.isFileAttachment()) return { status: 404, json: { error: "No such attachment" } };
    if (item.attachmentLinkMode === 2 && !this.syncLinkedEnabled()) {
      return { status: 404, json: { error: "Linked files are turned off on this PC" } };
    }
    const path = this.resolveAttachmentPath(key, item.attachmentLinkMode, item.attachmentPath);
    if (!path) return { status: 404, json: { error: "File location unknown" } };
    let bytes;
    try {
      bytes = await IOUtils.read(path);
    } catch (e) {
      return { status: 404, json: { error: "File missing" } };
    }
    return { status: 200, bytes, type: item.attachmentContentType || "application/octet-stream" };
  },

  // ================================================================ classifying (the "difference" list)

  /*
   * Compare a change set from the other PC with this PC's library.
   * Returns rows describing what applying it would do. Unchanged things are left out.
   * Row: { id, kind, lib, libName, key, action, label, type, context, detail, size, parents, checked, disabled }
   * action: new | update | conflict | delete | blocked
   */
  async classifyChanges(changes) {
    const rows = [];
    const ids = new Set();
    const syncGroups = this.syncGroupsEnabled();
    const syncLinked = this.syncLinkedEnabled();
    const remoteGroups = {};
    for (const g of changes.groups || []) remoteGroups["g" + g.groupID] = g;

    const usable = (lib) => lib === "u" || (syncGroups && (!!this.libIDFor(lib) || !!remoteGroups[lib]));
    const add = (r) => {
      if (ids.has(r.id)) return;
      if (r.checked === undefined) r.checked = r.action === "new" || r.action === "update" || r.action === "delete";
      r.libName = this.libName(r.lib, remoteGroups);
      r.parents = (r.parents || []).filter((p) => ids.has(p));
      rows.push(r);
      ids.add(r.id);
    };
    const groupParent = (lib) => (ids.has(`group:${lib}`) ? [`group:${lib}`] : []);

    // --- group libraries that don't exist here yet
    for (const g of changes.groups || []) {
      if (!syncGroups) break;
      let exists = false;
      try {
        exists = !!Zotero.Groups.get(g.groupID);
      } catch (e) {}
      if (exists) continue;
      add({
        id: `group:g${g.groupID}`,
        kind: "group",
        lib: "g" + g.groupID,
        action: "new",
        label: g.name,
        type: "Group library",
        detail: "Will be created on this PC",
      });
    }

    // --- collections
    for (const e of changes.collections || []) {
      if (!usable(e.lib)) continue;
      const json = e.json;
      const libID = this.libIDFor(e.lib);
      const local = libID ? Zotero.Collections.getByLibraryAndKey(libID, json.key) : null;
      let action = "new";
      let detail = "";
      if (local) {
        if (local.name === json.name && (local.parentKey || false) === (json.parentCollection || false)) continue;
        const localMod = await Zotero.DB.valueQueryAsync("SELECT clientDateModified FROM collections WHERE collectionID=?", [local.id]);
        if (!e.mod || !localMod || e.mod >= localMod) {
          action = "update";
          detail = local.name !== json.name ? `Renamed from “${local.name}”` : "Moved to a different parent collection";
        } else {
          action = "conflict";
          detail = "Changed on both PCs; this PC's version is newer. Tick to overwrite it.";
        }
      }
      const parents = groupParent(e.lib);
      if (json.parentCollection) parents.push(`collection:${e.lib}:${json.parentCollection}`);
      add({ id: `collection:${e.lib}:${json.key}`, kind: "collection", lib: e.lib, key: json.key, action, label: json.name, type: "Collection", detail, parents });
    }

    // --- items
    const incoming = new Map();
    for (const e of changes.items || []) incoming.set(e.lib + ":" + e.json.key, e.json);

    for (const e of changes.items || []) {
      if (!usable(e.lib)) continue;
      const json = e.json;
      const libID = this.libIDFor(e.lib);
      const local = libID ? Zotero.Items.getByLibraryAndKey(libID, json.key) : null;
      let action = "new";
      let detail = "";
      if (local) {
        const localMod = local.dateModified;
        const remoteMod = json.dateModified ? Zotero.Date.isoToSQL(json.dateModified) : null;
        if (remoteMod && localMod && remoteMod === localMod) {
          // Same edit time: only collections/tags/trash may differ. Compare the content.
          await local.loadAllData();
          let localJSON = null;
          try {
            localJSON = local.toJSON();
          } catch (err) {}
          if (localJSON && this.canonicalItem(localJSON) === this.canonicalItem(json)) continue;
          const localClientMod = await Zotero.DB.valueQueryAsync("SELECT clientDateModified FROM items WHERE itemID=?", [local.id]);
          if (!e.mod || !localClientMod || e.mod >= localClientMod) {
            action = "update";
            detail = "Collections, tags or trash status changed";
          } else {
            action = "conflict";
            detail = "Collections or tags changed on both PCs; this PC's version is newer. Tick to overwrite it.";
          }
        } else if (!remoteMod || !localMod || remoteMod > localMod) {
          action = "update";
          if (json.deleted && !local.deleted) detail = "Moved to the trash on the other PC";
        } else {
          action = "conflict";
          detail = "Edited on both PCs; this PC's version is newer. Tick to overwrite it.";
        }
      }
      const parents = groupParent(e.lib);
      if (json.parentItem) parents.push(`item:${e.lib}:${json.parentItem}`);
      add({
        id: `item:${e.lib}:${json.key}`,
        kind: "item",
        lib: e.lib,
        key: json.key,
        action,
        label: this.itemLabel(json),
        type: this.typeLabel(json.itemType),
        context: this.parentTitle(e.lib, json.parentItem, incoming),
        detail,
        parents,
      });
    }

    // --- deletions
    for (const d of changes.deletions || []) {
      if (!usable(d.lib)) continue;
      const libID = this.libIDFor(d.lib);
      if (!libID) continue;
      const isColl = d.type === "collection";
      const obj = (isColl ? Zotero.Collections : Zotero.Items).getByLibraryAndKey(libID, d.key);
      if (!obj) continue;
      const localMod = await Zotero.DB.valueQueryAsync(
        `SELECT clientDateModified FROM ${isColl ? "collections" : "items"} WHERE ${isColl ? "collectionID" : "itemID"}=?`,
        [obj.id]
      );
      const conflict = !!(localMod && localMod > d.date);
      let label = "";
      try {
        label = isColl ? obj.name : obj.getDisplayTitle();
      } catch (e) {}
      add({
        id: `delete:${d.lib}:${d.type}:${d.key}`,
        kind: "delete",
        lib: d.lib,
        key: d.key,
        action: conflict ? "conflict" : "delete",
        label: label || d.key,
        type: isColl ? "Collection" : this.typeLabel(obj.itemType),
        detail: conflict
          ? "Deleted on the other PC, but edited here afterwards. Tick to delete it anyway."
          : "Deleted on the other PC",
      });
    }

    // --- files
    for (const f of changes.files || []) {
      if (!usable(f.lib)) continue;
      if (f.linked && !syncLinked) continue;
      const libID = this.libIDFor(f.lib);
      const json = incoming.get(f.lib + ":" + f.key);
      let linkMode;
      let path;
      let context = "";
      if (json) {
        if (json.itemType !== "attachment") continue;
        linkMode = LS_LINK_MODES[json.linkMode];
        path = linkMode === 2 ? json.path : json.filename ? "storage:" + json.filename : null;
        context = this.parentTitle(f.lib, json.parentItem, incoming) || this.itemLabel(json);
      } else {
        const it = libID && Zotero.Items.getByLibraryAndKey(libID, f.key);
        if (!it || !it.isFileAttachment()) continue;
        linkMode = it.attachmentLinkMode;
        path = it.attachmentPath;
        context = this.parentTitle(f.lib, it.parentKey, incoming);
      }
      const parents = groupParent(f.lib);
      parents.push(`item:${f.lib}:${f.key}`);
      const base = {
        id: `file:${f.lib}:${f.key}`,
        kind: "file",
        lib: f.lib,
        key: f.key,
        type: f.linked ? "Linked file" : "Stored file",
        context,
        size: f.size,
        parents,
      };
      const badName = this.invalidNameHere(path);
      if (badName) {
        add(Object.assign(base, {
          action: "blocked",
          label: f.name,
          detail: `“${badName}” isn't a valid name on Windows. Rename the file in Zotero on the other PC (right-click → Rename File from Parent Metadata).`,
          checked: false,
          disabled: true,
        }));
        continue;
      }
      const localPath = this.resolveAttachmentPath(f.key, linkMode, path);
      if (!localPath) {
        if (f.linked) {
          add(Object.assign(base, { action: "blocked", label: f.name, detail: this.linkedReason(path), checked: false, disabled: true }));
        }
        continue;
      }
      let st = null;
      try {
        st = await IOUtils.stat(localPath);
      } catch (e) {}
      if (st) {
        if (st.size === f.size && Math.abs(st.lastModified - f.mtime) < 2000) continue;
        if (st.lastModified > f.mtime) continue; // this PC's copy is newer; it shows up in the other direction
      }
      add(Object.assign(base, {
        action: st ? "update" : "new",
        label: PathUtils.filename(localPath),
        detail: this.formatSize(f.size) + (st ? ` (this PC has ${this.formatSize(st.size)}, older)` : "") + (f.linked ? ` → ${localPath}` : ""),
      }));
    }

    return rows;
  },

  // ================================================================ applying

  async applyChanges(changes, rows, selected, fileBase) {
    const stats = { groups: 0, collections: 0, items: 0, deleted: 0, files: 0, kept: 0, errors: [] };
    const failedLibs = new Set();
    const incompleteLibs = new Set();
    const sel = (id) => selected.has(id);
    const fail = (lib, msg, e) => {
      stats.errors.push(msg);
      failedLibs.add(lib);
      if (e) Zotero.logError(e);
    };

    for (const r of rows) {
      if (!selected.has(r.id)) {
        stats.kept++;
        if (r.kind !== "file") incompleteLibs.add(r.lib);
      }
    }

    // --- group libraries
    for (const g of changes.groups || []) {
      const lib = "g" + g.groupID;
      if (!sel(`group:${lib}`)) continue;
      try {
        if (!Zotero.Groups.get(g.groupID)) {
          const group = new Zotero.Group({
            groupID: g.groupID,
            name: g.name,
            description: g.description || "",
            version: 0,
            editable: g.editable !== false,
            filesEditable: g.filesEditable !== false,
          });
          await group.saveTx();
          stats.groups++;
        }
      } catch (e) {
        fail(lib, `Group “${g.name}”: ${e.message || e}`, e);
      }
    }

    // --- collections (several passes so parents come first)
    let pending = (changes.collections || []).filter((e) => sel(`collection:${e.lib}:${e.json.key}`));
    let progress = true;
    while (pending.length && progress) {
      progress = false;
      const next = [];
      for (const e of pending) {
        const json = e.json;
        const libID = this.libIDFor(e.lib);
        if (!libID) {
          fail(e.lib, `Collection “${json.name}”: its library isn't on this PC`);
          continue;
        }
        if (json.parentCollection && !Zotero.Collections.getByLibraryAndKey(libID, json.parentCollection)) {
          next.push(e);
          continue;
        }
        progress = true;
        try {
          let c = Zotero.Collections.getByLibraryAndKey(libID, json.key);
          const isNew = !c;
          if (isNew) {
            // Same steps as Zotero's own sync: once the key is set, the object counts as "identified",
            // and loadPrimaryData() marks a not-yet-saved object as fully loaded so fields can be set.
            c = new Zotero.Collection();
            c.libraryID = libID;
            c.key = json.key;
            await c.loadPrimaryData();
          } else {
            await c.loadAllData();
          }
          c.fromJSON(json);
          await c.saveTx({ skipDateModifiedUpdate: true, skipSelect: true, skipEditCheck: true });
          stats.collections++;
        } catch (err) {
          fail(e.lib, `Collection “${json.name}”: ${err.message || err}`, err);
        }
      }
      pending = next;
    }
    for (const e of pending) fail(e.lib, `Collection “${e.json.name}”: its parent collection wasn't synced`);

    // --- items (several passes so parents come first)
    pending = (changes.items || []).filter((e) => sel(`item:${e.lib}:${e.json.key}`));
    progress = true;
    while (pending.length && progress) {
      progress = false;
      const next = [];
      for (const e of pending) {
        let json = e.json;
        const libID = this.libIDFor(e.lib);
        if (!libID) {
          fail(e.lib, `“${this.itemLabel(json)}”: its library isn't on this PC`);
          continue;
        }
        if (json.parentItem && !Zotero.Items.getByLibraryAndKey(libID, json.parentItem)) {
          next.push(e);
          continue;
        }
        progress = true;
        try {
          if (Array.isArray(json.collections) && json.collections.length) {
            const keep = json.collections.filter((k) => Zotero.Collections.getByLibraryAndKey(libID, k));
            if (keep.length !== json.collections.length) json = Object.assign({}, json, { collections: keep });
          }
          let item = Zotero.Items.getByLibraryAndKey(libID, json.key);
          const isNew = !item;
          if (!isNew) {
            await item.loadAllData();
          } else {
            // Same steps as Zotero's own sync (see collections above); fromJSON() sets the item type.
            item = new Zotero.Item();
            item.libraryID = libID;
            item.key = json.key;
            await item.loadPrimaryData();
          }
          item.fromJSON(json);
          await item.saveTx({ skipDateModifiedUpdate: true, skipSelect: true, skipEditCheck: true });
          stats.items++;
        } catch (err) {
          fail(e.lib, `“${this.itemLabel(json)}”: ${err.message || err}`, err);
        }
      }
      pending = next;
    }
    for (const e of pending) fail(e.lib, `“${this.itemLabel(e.json)}”: its parent item wasn't synced`);

    // --- deletions
    for (const d of changes.deletions || []) {
      if (!sel(`delete:${d.lib}:${d.type}:${d.key}`)) continue;
      try {
        const libID = this.libIDFor(d.lib);
        if (!libID) continue;
        const obj = (d.type === "collection" ? Zotero.Collections : Zotero.Items).getByLibraryAndKey(libID, d.key);
        if (!obj) continue;
        await obj.eraseTx({ skipDeleteLog: true, skipEditCheck: true });
        stats.deleted++;
      } catch (e) {
        fail(d.lib, `Delete ${d.type} ${d.key}: ${e.message || e}`, e);
      }
    }

    // --- files (file errors don't hold back the watermark; files are compared in full every time)
    for (const f of changes.files || []) {
      if (!sel(`file:${f.lib}:${f.key}`)) continue;
      try {
        const libID = this.libIDFor(f.lib);
        const item = libID && Zotero.Items.getByLibraryAndKey(libID, f.key);
        if (!item || !item.isFileAttachment()) {
          stats.errors.push(`File ${f.name}: its attachment item isn't on this PC`);
          continue;
        }
        const path = this.resolveAttachmentPath(f.key, item.attachmentLinkMode, item.attachmentPath);
        if (!path) {
          stats.errors.push(`File ${f.name}: ${this.linkedReason(item.attachmentPath)}`);
          continue;
        }
        const buf = await this.request("GET", `${fileBase}/file/${f.lib}/${f.key}`, undefined, { binary: true });
        await IOUtils.makeDirectory(PathUtils.parent(path), { ignoreExisting: true, createAncestors: true });
        await IOUtils.write(path, new Uint8Array(buf));
        await IOUtils.setModificationTime(path, f.mtime);
        stats.files++;
        try {
          Zotero.Fulltext.indexItems([item.id]).catch(() => {});
        } catch (e) {}
      } catch (e) {
        stats.errors.push(`File ${f.name}: ${e.message || e}`);
        Zotero.logError(e);
      }
    }

    return { stats, failedLibs, incompleteLibs };
  },

  // ================================================================ client side

  parsePeer(peer) {
    let host = peer.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    let port = 23120;
    const m = host.match(/^(.*):(\d+)$/);
    if (m) {
      host = m[1];
      port = parseInt(m[2]);
    }
    return { host, port };
  },

  baseURL(host, port) {
    const h = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
    return `http://${h}:${port}/lansync`;
  },

  // Turns a failed connection into a specific explanation instead of blaming the firewall for everything.
  explainUnreachable(url, elapsedMs, timeoutMs, underlying) {
    const where = url.replace(/^https?:\/\//, "").replace(/\/lansync.*$/, "");
    let why;
    if (timeoutMs && elapsedMs >= timeoutMs - 500) {
      why = `No answer from ${where} within ${Math.round(timeoutMs / 1000)} s. Something is silently dropping the connection: `
        + "usually the other PC's firewall (a Block rule for Zotero, or the network set to Public while the rule only covers Private), "
        + "a wrong IP address, a VPN, or a router/guest Wi-Fi that stops devices talking to each other.";
    } else if (elapsedMs < 3000) {
      why = `${where} closed the connection without replying. Either nothing is listening on that port `
        + "(Zotero isn't open there, the plugin isn't enabled there, or the port differs), or the plugin on that PC "
        + "hit an error while answering. If Test connection works, it's the second: turn on Help → Debug Output Logging "
        + "on that PC, sync again, and look for [LocalSync] server: lines there.";
    } else {
      why = `The connection to ${where} failed after ${Math.round(elapsedMs / 1000)} s (network or firewall problem).`;
    }
    if (underlying) why += ` [${underlying}]`;
    return why;
  },

  async request(method, url, body, { binary = false, timeout = 30 * 60 * 1000 } = {}) {
    let xhr;
    let underlying = "";
    const start = Date.now();
    try {
      xhr = await Zotero.HTTP.request(method, url, {
        body: body !== undefined ? JSON.stringify(body) : undefined,
        headers: {
          "X-LanSync-Token": this.getPref("token"),
          "X-LanSync-Device": this.getPref("deviceID"),
          "Content-Type": "application/json",
        },
        responseType: binary ? "arraybuffer" : "text",
        timeout,
        successCodes: false,
      });
    } catch (e) {
      underlying = (e && (e.name || "") + (e.message ? ": " + e.message : "")) || String(e);
      this.log(`request ${method} ${url} failed after ${Date.now() - start} ms: ${underlying}`);
    }
    if (!xhr || xhr.status === 0) {
      throw new Error(this.explainUnreachable(url, Date.now() - start, timeout, underlying));
    }
    if (xhr.status !== 200) {
      let msg = "";
      try {
        msg = JSON.parse(binary ? this.utf8Decode(new Uint8Array(xhr.response)) : xhr.responseText).error;
      } catch (e) {}
      throw new Error(`HTTP ${xhr.status}${msg ? ": " + msg : ""}`);
    }
    return binary ? xhr.response : JSON.parse(xhr.responseText);
  },

  async buildPlan() {
    const peer = (this.getPref("peer") || "").trim();
    if (!peer) throw new Error("Set the peer address in Settings → Local Sync first.");
    if (!this.getPref("token")) throw new Error("Set a shared token in Settings → Local Sync first (the same one on both PCs).");

    const { host, port } = this.parsePeer(peer);
    const base = this.baseURL(host, port);
    const myID = this.getPref("deviceID");

    const info = await this.request("GET", base + "/info", undefined, { timeout: 15000 });
    if (info.protocol !== LS_PROTOCOL) {
      throw new Error("The other PC is running a different version of Local Sync. Install the same version on both PCs.");
    }
    if (info.deviceID === myID) throw new Error("The peer address points at this same computer.");

    const state = this.getState();
    const lp = this.normalizeWatermark(state.lastPulled[info.deviceID]);
    const incomingChanges = await this.request("POST", base + "/changes", { sinceByLib: lp });
    const incomingRows = await this.classifyChanges(incomingChanges);

    const outgoingChanges = await this.getChanges(this.normalizeWatermark(info.watermarkForYou));
    const preview = await this.request("POST", base + "/preview", { changes: outgoingChanges, deviceID: myID, port: this.getPort() });

    return {
      host,
      port,
      base,
      peerDeviceID: info.deviceID,
      peerName: info.name || host,
      incoming: { changes: incomingChanges, rows: incomingRows },
      outgoing: { planID: preview.planID, rows: preview.rows || [] },
      warning: preview.warning || "",
    };
  },

  defaultSelection(rows) {
    return rows.filter((r) => r.checked && !r.disabled).map((r) => r.id);
  },

  async applyPlan(plan, inSelected, outSelected) {
    if (this.syncing) throw new Error("A sync is already running.");
    this.syncing = true;
    try {
      const inRes = await this.applyChanges(plan.incoming.changes, plan.incoming.rows, new Set(inSelected), plan.base);
      this.advanceWatermark(plan.peerDeviceID, plan.incoming.changes, inRes.failedLibs, inRes.incompleteLibs);
      const outStats = await this.request("POST", plan.base + "/apply", { planID: plan.outgoing.planID, selected: outSelected });
      const result = { incoming: inRes.stats, outgoing: outStats };
      this.setPref(
        "lastResult",
        `${new Date().toLocaleString()}: synced with ${plan.peerName}. Received: ${this.summarize(result.incoming)} | Sent: ${this.summarize(result.outgoing)}`
      );
      const errs = result.incoming.errors.concat(result.outgoing.errors || []);
      if (errs.length) this.log("errors: " + JSON.stringify(errs));
      return result;
    } finally {
      this.syncing = false;
    }
  },

  async syncNow({ quiet = false } = {}) {
    if (this.syncing || this.planning) {
      if (!quiet) this.notify("A sync is already running.");
      return;
    }
    this.planning = true;
    try {
      if (!quiet) this.notify("Comparing with the other PC…");
      const plan = await this.buildPlan();
      const res = await this.applyPlan(plan, this.defaultSelection(plan.incoming.rows), this.defaultSelection(plan.outgoing.rows));
      if (plan.warning) this.notify(plan.warning, true);
      const errCount = res.incoming.errors.length + ((res.outgoing.errors && res.outgoing.errors.length) || 0);
      if (!quiet || errCount) {
        this.notify(`Received: ${this.summarize(res.incoming)}\nSent: ${this.summarize(res.outgoing)}`, errCount > 0);
      }
    } catch (e) {
      Zotero.logError(e);
      this.setPref("lastResult", `${new Date().toLocaleString()}: failed: ${e.message || e}`);
      if (!quiet) this.notify(String(e.message || e), true);
    } finally {
      this.planning = false;
    }
  },

  async reviewChanges() {
    if (this.syncing || this.planning) {
      this.notify("A sync is already running.");
      return;
    }
    this.planning = true;
    try {
      this.notify("Comparing with the other PC…");
      const plan = await this.buildPlan();
      if (!plan.incoming.rows.length && !plan.outgoing.rows.length) {
        await this.applyPlan(plan, [], []); // nothing to copy, but records that both sides are in step
        this.notify("Both PCs are already in sync.");
        return;
      }
      const win = Zotero.getMainWindow();
      win.openDialog(
        "chrome://lansync/content/preview.xhtml",
        "lansync-preview",
        "chrome,dialog=no,resizable,centerscreen,width=1000,height=700",
        { lanSync: this, plan }
      );
    } catch (e) {
      Zotero.logError(e);
      this.setPref("lastResult", `${new Date().toLocaleString()}: failed: ${e.message || e}`);
      this.notify(String(e.message || e), true);
    } finally {
      this.planning = false;
    }
  },

  summarize(s) {
    if (!s) return "";
    const parts = [
      `${s.items || 0} items`,
      `${s.collections || 0} collections`,
      `${s.files || 0} files`,
      `${s.deleted || 0} deletions`,
    ];
    if (s.groups) parts.push(`${s.groups} new group libraries`);
    if (s.kept) parts.push(`${s.kept} left as they were`);
    if (s.errors && s.errors.length) parts.push(`${s.errors.length} errors (see Help → Debug Output)`);
    return parts.join(", ");
  },

  // ================================================================ auto sync

  scheduleAutoSync() {
    if (this.timer) {
      this.timer.cancel();
      this.timer = null;
    }
    const mins = parseInt(this.getPref("autoSyncMinutes")) || 0;
    if (mins <= 0) return;
    this.timer = LS_Cc["@mozilla.org/timer;1"].createInstance(LS_Ci.nsITimer);
    this.timer.initWithCallback(
      { notify: () => this.syncNow({ quiet: true }) },
      mins * 60 * 1000,
      LS_Ci.nsITimer.TYPE_REPEATING_SLACK
    );
  },
};
