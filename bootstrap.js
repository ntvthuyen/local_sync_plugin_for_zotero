/* global Zotero, Services, Components */
var LanSync;
var chromeHandle;

function install() {}
function uninstall() {}

function startup({ id, version, rootURI }) {
  const aomStartup = Components.classes["@mozilla.org/addons/addon-manager-startup;1"]
    .getService(Components.interfaces.amIAddonManagerStartup);
  const manifestURI = Services.io.newURI(rootURI + "manifest.json");
  chromeHandle = aomStartup.registerChrome(manifestURI, [["content", "lansync", rootURI + "content/"]]);

  Services.scriptloader.loadSubScript(rootURI + "lansync.js");
  LanSync.init({ id, version, rootURI });
  for (const win of Zotero.getMainWindows()) {
    if (win.ZoteroPane) LanSync.addToWindow(win);
  }
}

function onMainWindowLoad({ window }) {
  LanSync.addToWindow(window);
}

function onMainWindowUnload({ window }) {
  LanSync.removeFromWindow(window);
}

function shutdown() {
  // Close any open review windows
  try {
    const en = Services.wm.getEnumerator(null);
    while (en.hasMoreElements()) {
      const w = en.getNext();
      if (w.location && String(w.location.href).startsWith("chrome://lansync/")) w.close();
    }
  } catch (e) {}

  if (LanSync) LanSync.shutdown();
  LanSync = undefined;

  if (chromeHandle) {
    chromeHandle.destruct();
    chromeHandle = null;
  }
}
