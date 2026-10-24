import {
  aliasProblem, checkTabUrl, createClient, describeError, filterLinks, hostOf, loadSettings, relativeTime, shortLabel,
  sortLinks, toCsv,
} from "./shared.js";
import { drawQr, qrPngBlob, qrSvgBlob } from "./qr.js";
import { copyText, downloadBlob, flashDone, icon, mountIcons, slug, toast } from "./ui.js";

const $ = (id) => document.getElementById(id);

let client = null;
let base = "";
let links = [];
const selected = new Set();
const view = { query: "", sort: "newest" };
let loadState = "loading"; // loading | ready | error

// ------------------------------------------------------------------ helpers

const visible = () => sortLinks(filterLinks(links, view.query), view.sort);
const el = (tag, props = {}, ...kids) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...kids);
  return node;
};

function iconButton(name, label, onClick, extraClass = "") {
  const b = el("button", { type: "button", className: `icon-btn ${extraClass}`.trim(), title: label });
  b.setAttribute("aria-label", label);
  b.innerHTML = icon(name);
  b.addEventListener("click", () => onClick(b));
  return b;
}

// ------------------------------------------------------------------- render

function renderRows() {
  const rows = $("rows");
  rows.replaceChildren();
  const list = visible();
  const showBy = links.some((l) => l.createdBy);
  $("by-head").hidden = !showBy;

  if (loadState === "loading" && links.length === 0) {
    for (let i = 0; i < 5; i++) {
      const tr = el("tr", { className: "skel-row" });
      for (let c = 0; c < (showBy ? 6 : 5); c++) tr.append(el("td", {}, el("div", { className: "skeleton" })));
      rows.append(tr);
    }
  }

  for (const l of loadState === "loading" && links.length === 0 ? [] : list) {
    const tr = el("tr", { className: selected.has(l.code) ? "selected" : "" });
    tr.dataset.code = l.code;

    const cb = el("input", { type: "checkbox", checked: selected.has(l.code) });
    cb.setAttribute("aria-label", `Select ${l.code}`);
    cb.addEventListener("change", () => {
      cb.checked ? selected.add(l.code) : selected.delete(l.code);
      tr.classList.toggle("selected", cb.checked);
      renderChrome();
    });

    const code = el("td", { className: "code-cell" },
      el("a", { href: `${base}/${l.code}`, target: "_blank", rel: "noopener noreferrer", title: "Open short link" },
        el("span", { className: "host", textContent: `${hostOf(base)}/` }), l.code));

    const dest = el("td", { className: "dest-cell" },
      el("div", { className: "dest-title", textContent: l.title || hostOf(l.url), title: l.title || "" }),
      el("div", { className: "dest-url", textContent: l.url, title: l.url }));

    const when = el("td", { className: "when", textContent: relativeTime(l.createdAt), title: new Date(l.createdAt).toLocaleString() });

    const actions = el("td", {}, el("div", { className: "row-actions" },
      iconButton("copy", `Copy ${shortLabel(base, l.code)}`, async (b) => {
        if (await copyText(`${base}/${l.code}`)) { flashDone(b); toast("Copied to clipboard"); }
        else toast("Could not copy", "err");
      }),
      iconButton("open", "Open destination", () => window.open(l.url, "_blank", "noopener,noreferrer")),
      iconButton("qr", "Show QR code", () => openQr(l)),
      iconButton("edit", "Edit link", () => openEdit(l)),
      iconButton("trash", "Delete link", () => openDelete([l]), "danger")));

    tr.append(el("td", { className: "sel" }, cb), code, dest, when);
    if (showBy) tr.append(el("td", { className: "when", textContent: l.createdBy ?? "" }));
    tr.append(actions);
    rows.append(tr);
  }
}

function renderChrome() {
  const list = visible();
  const hasLinks = links.length > 0;
  const empty = loadState === "ready" && list.length === 0;
  $("empty").hidden = !empty;
  $("table").hidden = loadState === "ready" && list.length === 0;
  if (empty) {
    $("empty-title").textContent = hasLinks ? "No matching links" : "No links yet";
    $("empty-text").textContent = hasLinks ? "Try a different search." : "Create one above, or click the LF GO icon on any page.";
  }
  $("count").textContent = loadState === "ready" ? `${list.length} of ${links.length} ${links.length === 1 ? "link" : "links"}` : "";

  const shownSelected = list.filter((l) => selected.has(l.code)).length;
  const all = $("select-all");
  all.checked = list.length > 0 && shownSelected === list.length;
  all.indeterminate = shownSelected > 0 && shownSelected < list.length;
  all.disabled = list.length === 0;
  $("bulk-delete").hidden = selected.size === 0;
  $("bulk-label").textContent = `Delete ${selected.size} selected`;
  $("export").disabled = list.length === 0;
}

const render = () => { renderRows(); renderChrome(); };

// -------------------------------------------------------------------- load

async function load() {
  $("error").hidden = true;
  loadState = "loading";
  render();
  try {
    links = await client.listAll();
    for (const code of [...selected]) if (!links.some((l) => l.code === code)) selected.delete(code);
    loadState = "ready";
  } catch (err) {
    loadState = "error";
    $("error-text").textContent = describeError(err, base);
    $("error").hidden = false;
  }
  render();
}

// ------------------------------------------------------------------ create

$("create").addEventListener("submit", async (e) => {
  e.preventDefault();
  const msg = $("create-msg");
  const say = (t, k = "") => { msg.textContent = t; msg.className = `msg create-msg ${k}`.trim(); };
  const url = checkTabUrl($("new-url").value.trim());
  if (!url.ok) return say("Enter a full web address starting with http:// or https://", "err");
  const alias = $("new-alias").value.trim().toLowerCase();
  if (alias) {
    const problem = aliasProblem(alias);
    if (problem) return say(problem, "err");
  }
  $("create-btn").disabled = true;
  say("Creating…");
  try {
    const link = await client.create(url.url, alias || undefined);
    links.push(link);
    $("new-url").value = "";
    $("new-alias").value = "";
    const copied = await copyText(`${base}/${link.code}`);
    say(`Created ${shortLabel(base, link.code)}${copied ? " and copied it" : ""}.`, "ok");
    render();
    $("new-url").focus();
  } catch (err) {
    say(describeError(err, base), "err");
  } finally {
    $("create-btn").disabled = false;
  }
});

// -------------------------------------------------------------------- edit

let editing = null;
function openEdit(l) {
  editing = l;
  $("edit-prefix").textContent = `${hostOf(base)}/`;
  $("edit-alias").value = l.code;
  $("edit-url").value = l.url;
  $("edit-title").value = l.title ?? "";
  $("edit-msg").textContent = "";
  $("edit-dialog").showModal();
  $("edit-alias").focus();
}
$("edit-cancel").addEventListener("click", () => $("edit-dialog").close());
$("edit-alias").addEventListener("input", () => { $("edit-alias").value = $("edit-alias").value.toLowerCase().replace(/\s+/g, "-"); });
$("edit-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const msg = $("edit-msg");
  msg.className = "msg err";
  const alias = $("edit-alias").value.trim();
  const url = checkTabUrl($("edit-url").value.trim());
  const title = $("edit-title").value.trim();
  if (alias !== editing.code) {
    const problem = aliasProblem(alias);
    if (problem) return (msg.textContent = problem);
  }
  if (!url.ok) return (msg.textContent = "Enter a full web address starting with http:// or https://");

  const patch = {};
  if (alias !== editing.code) patch.newCode = alias;
  if ($("edit-url").value.trim() !== editing.url) patch.url = url.url;
  if (title !== (editing.title ?? "")) patch.title = title;
  if (Object.keys(patch).length === 0) return $("edit-dialog").close();

  $("edit-save").disabled = true;
  msg.className = "msg";
  msg.textContent = "Saving…";
  try {
    const updated = await client.update(editing.code, patch);
    const i = links.findIndex((x) => x.code === editing.code);
    if (i >= 0) links[i] = updated;
    if (selected.delete(editing.code)) selected.add(updated.code);
    $("edit-dialog").close();
    render();
    toast("Link updated");
  } catch (err) {
    msg.className = "msg err";
    msg.textContent = describeError(err, base);
  } finally {
    $("edit-save").disabled = false;
  }
});

// ------------------------------------------------------------------ delete

let pendingDelete = [];
function openDelete(targets) {
  pendingDelete = targets;
  const one = targets.length === 1;
  $("delete-title").textContent = one ? "Delete this link?" : `Delete ${targets.length} links?`;
  $("delete-text").textContent = one
    ? `${shortLabel(base, targets[0].code)} will stop working. This cannot be undone.`
    : `${targets.slice(0, 5).map((t) => t.code).join(", ")}${targets.length > 5 ? `, and ${targets.length - 5} more` : ""} will stop working. This cannot be undone.`;
  $("delete-msg").textContent = "";
  $("delete-confirm").disabled = false;
  $("delete-dialog").showModal();
  $("delete-cancel").focus();
}
$("delete-cancel").addEventListener("click", () => $("delete-dialog").close());
$("delete-confirm").addEventListener("click", async () => {
  $("delete-confirm").disabled = true;
  $("delete-msg").className = "msg";
  $("delete-msg").textContent = "Deleting…";
  const queue = [...pendingDelete];
  const failed = [];
  await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
    for (let l = queue.shift(); l; l = queue.shift()) {
      try {
        await client.remove(l.code);
        links = links.filter((x) => x.code !== l.code);
        selected.delete(l.code);
      } catch (err) {
        // Already gone is fine; anything else is reported.
        if (err.status === 404) { links = links.filter((x) => x.code !== l.code); selected.delete(l.code); }
        else failed.push(l.code);
      }
    }
  }));
  render();
  if (failed.length) {
    $("delete-msg").className = "msg err";
    $("delete-msg").textContent = `Could not delete: ${failed.join(", ")}. Try again.`;
    $("delete-confirm").disabled = false;
    pendingDelete = pendingDelete.filter((l) => failed.includes(l.code));
    return;
  }
  $("delete-dialog").close();
  toast(pendingDelete.length === 1 ? "Link deleted" : `${pendingDelete.length} links deleted`);
});
$("bulk-delete").addEventListener("click", () => openDelete(links.filter((l) => selected.has(l.code))));

// ---------------------------------------------------------------------- qr

let qrLink = null;
function openQr(l) {
  qrLink = l;
  const url = `${base}/${l.code}`;
  $("qr-title").textContent = l.title || "QR code";
  $("qr-url").textContent = shortLabel(base, l.code);
  drawQr($("qr-canvas"), url, 512);
  $("qr-dialog").showModal();
}
$("qr-close").addEventListener("click", () => $("qr-dialog").close());
$("qr-png").addEventListener("click", async () => downloadBlob(await qrPngBlob(`${base}/${qrLink.code}`, 1024), `lf-go-${slug(qrLink.code)}-qr.png`));
$("qr-svg").addEventListener("click", () => downloadBlob(qrSvgBlob(`${base}/${qrLink.code}`), `lf-go-${slug(qrLink.code)}-qr.svg`));

// ------------------------------------------------------------ toolbar & misc

$("search").addEventListener("input", () => { view.query = $("search").value; render(); });
$("sort").addEventListener("change", () => { view.sort = $("sort").value; render(); });
$("select-all").addEventListener("change", () => {
  const list = visible();
  if ($("select-all").checked) list.forEach((l) => selected.add(l.code));
  else list.forEach((l) => selected.delete(l.code));
  render();
});
$("export").addEventListener("click", () => {
  const stamp = new Date().toISOString().slice(0, 10);
  downloadBlob(new Blob([toCsv(visible(), base)], { type: "text/csv;charset=utf-8" }), `lf-go-links-${stamp}.csv`);
  toast("Exported to CSV");
});
$("refresh").addEventListener("click", () => client && load());
$("retry").addEventListener("click", () => client && load());
$("settings").addEventListener("click", () => chrome.runtime.openOptionsPage());
$("error-settings").addEventListener("click", () => chrome.runtime.openOptionsPage());
document.addEventListener("keydown", (e) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName ?? "");
  if (e.key === "/" && !typing && !document.querySelector("dialog[open]")) {
    e.preventDefault();
    $("search").focus();
  }
});

(async function init() {
  mountIcons();
  const settings = await loadSettings();
  base = settings.base;
  if (!settings.apiKey) {
    loadState = "error";
    $("error-text").textContent = "Add your API key in settings to manage your links.";
    $("error").hidden = false;
    $("retry").hidden = true;
    render();
    return;
  }
  client = createClient({ base, apiKey: settings.apiKey });
  await load();
})();
