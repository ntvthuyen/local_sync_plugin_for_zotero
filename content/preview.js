/* global window, document */
"use strict";

const HTML_NS = "http://www.w3.org/1999/xhtml";
const ACTION_LABELS = { new: "New", update: "Update", conflict: "Conflict", delete: "Delete", blocked: "Can't copy" };

let LS = null;
let plan = null;
let busy = false;
let done = false;

// Per direction: rows, checked state, checkbox elements, children index
const dirs = {
  in: { rows: [], byId: new Map(), checked: new Map(), boxes: new Map(), trs: new Map(), children: new Map(), countEl: null },
  out: { rows: [], byId: new Map(), checked: new Map(), boxes: new Map(), trs: new Map(), children: new Map(), countEl: null },
};

function el(tag, attrs, ...kids) {
  const e = document.createElementNS(HTML_NS, tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === "text") e.textContent = v;
      else if (k === "class") e.className = v;
      else e.setAttribute(k, v === true ? "" : String(v));
    }
  }
  for (const k of kids) if (k) e.appendChild(k);
  return e;
}

window.addEventListener("load", () => {
  const args = window.arguments && window.arguments[0];
  if (!args || !args.plan) {
    document.getElementById("summary").textContent = "Nothing to show.";
    return;
  }
  LS = args.lanSync;
  plan = args.plan;

  try {
    if (window.outerWidth < 600) window.resizeTo(1000, 700);
  } catch (e) {}

  document.getElementById("heading").textContent = `Review changes with ${plan.peerName}`;
  document.title = `Local Sync: ${plan.peerName}`;

  setup("in", plan.incoming.rows);
  setup("out", plan.outgoing.rows);

  const main = document.getElementById("main");
  main.appendChild(buildSection("in", `From ${plan.peerName} → this PC`));
  main.appendChild(buildSection("out", `From this PC → ${plan.peerName}`));

  document.getElementById("search").addEventListener("input", applyFilter);
  document.getElementById("filter").addEventListener("change", applyFilter);
  document.getElementById("cancel").addEventListener("click", () => window.close());
  document.getElementById("apply").addEventListener("click", onApply);

  updateSummary();
  if (plan.warning) {
    const st = document.getElementById("status");
    st.classList.add("error");
    st.textContent = "⚠ " + plan.warning;
  }
});

function setup(dir, rows) {
  const d = dirs[dir];
  d.rows = rows;
  for (const r of rows) {
    d.byId.set(r.id, r);
    d.checked.set(r.id, !!r.checked && !r.disabled);
  }
  for (const r of rows) {
    for (const p of r.parents || []) {
      if (!d.byId.has(p)) continue;
      if (!d.children.has(p)) d.children.set(p, []);
      d.children.get(p).push(r.id);
    }
  }
}

function buildSection(dir, title) {
  const d = dirs[dir];
  const count = el("span", { class: "count" });
  d.countEl = count;
  const h2 = el("h2", { text: title + " " });
  h2.appendChild(count);

  const all = el("button", { class: "linkbtn", text: "Select all" });
  const none = el("button", { class: "linkbtn", text: "Select none" });
  all.addEventListener("click", () => setAll(dir, true));
  none.addEventListener("click", () => setAll(dir, false));

  const section = el("section", null, el("div", { class: "sec-head" }, h2, all, none));

  if (!d.rows.length) {
    section.appendChild(el("div", { class: "empty", text: "No differences in this direction." }));
    return section;
  }

  const table = el(
    "table",
    null,
    el("colgroup", null,
      el("col", { class: "c-check" }),
      el("col", { class: "c-action" }),
      el("col", { class: "c-title" }),
      el("col", { class: "c-type" }),
      el("col", { class: "c-lib" }))
  );
  const tbody = el("tbody");
  const frag = document.createDocumentFragment();
  for (const r of d.rows) frag.appendChild(buildRow(dir, r));
  tbody.appendChild(frag);
  table.appendChild(tbody);
  section.appendChild(table);
  return section;
}

function buildRow(dir, r) {
  const d = dirs[dir];
  const box = el("input", { type: "checkbox", disabled: !!r.disabled });
  box.checked = d.checked.get(r.id);
  box.addEventListener("change", () => {
    if (box.checked) check(dir, r.id);
    else uncheck(dir, r.id);
    updateSummary();
  });
  d.boxes.set(r.id, box);

  const titleCell = el("td", null,
    el("div", { class: "title", title: r.label, text: r.label || "(untitled)" }),
    r.context ? el("div", { class: "sub", title: r.context, text: "in: " + r.context }) : null,
    r.detail ? el("div", { class: "sub detail", text: r.detail }) : null);

  const tr = el("tr", { "data-action": r.action, "data-kind": r.kind },
    el("td", null, box),
    el("td", null, el("span", { class: `badge a-${r.action}`, text: ACTION_LABELS[r.action] || r.action })),
    titleCell,
    el("td", null, el("div", { class: "sub", text: r.type || r.kind })),
    el("td", null, el("div", { class: "sub", title: r.libName, text: r.libName || "" })));
  tr._search = [r.label, r.context, r.type, r.libName, r.detail].filter(Boolean).join(" ").toLowerCase();
  d.trs.set(r.id, tr);
  styleRow(dir, r.id);
  return tr;
}

function styleRow(dir, id) {
  const d = dirs[dir];
  const tr = d.trs.get(id);
  if (!tr) return;
  const r = d.byId.get(id);
  tr.classList.toggle("unchecked", !d.checked.get(id));
  tr.classList.toggle("disabled", !!r.disabled);
}

function setChecked(dir, id, value) {
  const d = dirs[dir];
  d.checked.set(id, value);
  const box = d.boxes.get(id);
  if (box) box.checked = value;
  styleRow(dir, id);
}

// Ticking something also ticks a parent it can't exist without
// (a NEW parent item, collection or group library).
function check(dir, id) {
  const d = dirs[dir];
  const r = d.byId.get(id);
  if (!r || r.disabled) return;
  setChecked(dir, id, true);
  for (const p of r.parents || []) {
    const pr = d.byId.get(p);
    if (pr && pr.action === "new" && !d.checked.get(p)) check(dir, p);
  }
}

// Unticking something NEW also unticks what can't exist without it
// (its notes, annotations, attachments and files, or everything in a new group).
function uncheck(dir, id) {
  const d = dirs[dir];
  const r = d.byId.get(id);
  setChecked(dir, id, false);
  if (!r || r.action !== "new") return;
  for (const c of d.children.get(id) || []) {
    if (d.checked.get(c)) uncheck(dir, c);
  }
}

function setAll(dir, value) {
  if (busy || done) return;
  const d = dirs[dir];
  for (const r of d.rows) {
    const tr = d.trs.get(r.id);
    if (tr && tr.style.display === "none") continue; // only what's visible under the current filter
    if (r.disabled) continue;
    setChecked(dir, r.id, value);
  }
  updateSummary();
}

function applyFilter() {
  const q = document.getElementById("search").value.trim().toLowerCase();
  const f = document.getElementById("filter").value;
  for (const dir of ["in", "out"]) {
    const d = dirs[dir];
    for (const r of d.rows) {
      const tr = d.trs.get(r.id);
      if (!tr) continue;
      let show = true;
      if (f === "file") show = r.kind === "file";
      else if (f) show = r.action === f;
      if (show && q) show = tr._search.includes(q);
      tr.style.display = show ? "" : "none";
    }
  }
}

function selectedIds(dir) {
  const d = dirs[dir];
  return d.rows.filter((r) => d.checked.get(r.id) && !r.disabled).map((r) => r.id);
}

function describe(dir) {
  const d = dirs[dir];
  const counts = {};
  for (const r of d.rows) counts[r.action] = (counts[r.action] || 0) + 1;
  const parts = [];
  for (const a of ["new", "update", "conflict", "delete", "blocked"]) {
    if (counts[a]) parts.push(`${counts[a]} ${ACTION_LABELS[a].toLowerCase()}`);
  }
  return parts.join(", ") || "nothing";
}

function updateSummary() {
  const nIn = selectedIds("in").length;
  const nOut = selectedIds("out").length;
  for (const dir of ["in", "out"]) {
    const d = dirs[dir];
    if (d.countEl) d.countEl.textContent = `(${selectedIds(dir).length} of ${d.rows.length} ticked)`;
  }
  document.getElementById("summary").textContent =
    `Incoming: ${describe("in")}. Outgoing: ${describe("out")}. `
    + "Conflicts (edited on both PCs) start unticked, so the newer copy is kept. Unticked changes are offered again next time.";
  document.getElementById("selcount").textContent =
    `${nIn} change${nIn === 1 ? "" : "s"} to this PC, ${nOut} to ${plan.peerName}`;
}

async function onApply() {
  if (busy) return;
  if (done) {
    window.close();
    return;
  }
  busy = true;
  const applyBtn = document.getElementById("apply");
  const cancelBtn = document.getElementById("cancel");
  const status = document.getElementById("status");
  applyBtn.disabled = true;
  cancelBtn.disabled = true;
  for (const dir of ["in", "out"]) for (const b of dirs[dir].boxes.values()) b.disabled = true;
  status.classList.remove("error");
  status.textContent = "Syncing… keep Zotero open on both PCs.";

  try {
    const res = await LS.applyPlan(plan, selectedIds("in"), selectedIds("out"));
    const errs = (res.incoming.errors || []).concat(res.outgoing.errors || []);
    status.textContent = `Done.\nReceived: ${LS.summarize(res.incoming)}\nSent: ${LS.summarize(res.outgoing)}`
      + (errs.length ? `\n\nProblems:\n• ${errs.slice(0, 8).join("\n• ")}${errs.length > 8 ? `\n…and ${errs.length - 8} more` : ""}` : "");
    if (errs.length) status.classList.add("error");
    done = true;
    applyBtn.textContent = "Close";
    applyBtn.disabled = false;
  } catch (e) {
    status.classList.add("error");
    status.textContent = "Sync failed: " + ((e && e.message) || e);
    applyBtn.textContent = "Close";
    applyBtn.disabled = false;
    done = true;
  } finally {
    busy = false;
  }
}
