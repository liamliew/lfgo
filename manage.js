import { AuthError, connect, signInWithGoogle, signOut } from "./auth.js";
import {
  aliasProblem, checkTabUrl, describeError, filterByLock, filterLinks, hostOf, isValidPin,
  randomPin, relativeTime, shortLabel, sortLinks, toCsv,
} from "./shared.js";
import { drawQr, qrPngBlob, qrSvgBlob } from "./qr.js";
import { copyText, downloadBlob, flashDone, icon, mountIcons, slug, toast } from "./ui.js";

const $ = (id) => document.getElementById(id);

let client = null;
let base = "";
let links = [];
const selected = new Set();
const view = { query: "", sort: "newest", lock: "all" };
let loadState = "loading"; // loading | ready | error

// ------------------------------------------------------------------ helpers

const visible = () => sortLinks(filterByLock(filterLinks(links, view.query), view.lock), view.sort);
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
        el("span", { className: "host", textContent: `${hostOf(base)}/` }), l.code),
      l.locked ? el("span", { className: "lock-badge", title: "Locked with a PIN", innerHTML: icon("lock") }) : "");

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
      iconButton("lock", l.locked ? "Change or remove PIN" : "Lock with a PIN", () => openPin(l), l.locked ? "locked" : ""),
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
    $("empty-text").textContent = hasLinks ? "Try a different search." : "Create one above, or click the LFC Tools icon on any page.";
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
    if (err?.code === "signed_out") return location.reload(); // shows the sign-in prompt
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
  const pin = $("new-pin").value.trim();
  if (pin && !isValidPin(pin)) return say("The PIN must be exactly 6 digits.", "err");
  $("create-btn").disabled = true;
  say("Creating…");
  try {
    const link = await client.create(url.url, alias || undefined, undefined, pin || undefined);
    links.push(link);
    $("new-url").value = "";
    $("new-alias").value = "";
    $("new-pin").value = "";
    const copied = await copyText(`${base}/${link.code}`);
    say(
      `Created ${shortLabel(base, link.code)}${copied ? " and copied it" : ""}.` +
        (pin ? ` Locked with PIN ${pin}. Save it now; it can't be shown again.` : ""),
      "ok",
    );
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

// ------------------------------------------------------------------ PIN lock

const digitsOnly = (input) => { input.value = input.value.replace(/\D/g, "").slice(0, 6); };
$("new-pin").addEventListener("input", () => digitsOnly($("new-pin")));
$("new-pin-random").addEventListener("click", () => { $("new-pin").value = randomPin(); });
$("pin-dialog-input").addEventListener("input", () => digitsOnly($("pin-dialog-input")));
$("pin-dialog-random").addEventListener("click", () => { $("pin-dialog-input").value = randomPin(); $("pin-dialog-input").focus(); });

let pinTarget = null;
let pinShown = ""; // the PIN just set; kept in memory only while the dialog is open
let removeArmed = false;
let removeTimer;

function paintPinDialog() {
  const done = !!pinShown;
  const l = pinTarget;
  $("pin-dialog-title").textContent = `PIN lock for ${shortLabel(base, l.code)}`;
  $("pin-dialog-state").textContent = l.locked
    ? "This link is locked. Visitors must enter its PIN."
    : "This link is open to anyone. Add a PIN to lock it.";
  $("pin-dialog-label").textContent = l.locked ? "New PIN" : "6-digit PIN";
  $("pin-dialog-save").textContent = l.locked ? "Change PIN" : "Lock link";
  $("pin-dialog-fields").hidden = done;
  $("pin-dialog-save").hidden = done;
  $("pin-dialog-remove").hidden = !l.locked || done;
  $("pin-dialog-remove").textContent = removeArmed ? "Click again to remove" : "Remove lock";
  $("pin-dialog-done").hidden = !done;
  $("pin-dialog-shown").textContent = pinShown;
  $("pin-dialog-close").textContent = done ? "Done" : "Close";
}

function openPin(l) {
  pinTarget = l;
  pinShown = "";
  removeArmed = false;
  $("pin-dialog-input").value = "";
  $("pin-dialog-msg").textContent = "";
  paintPinDialog();
  $("pin-dialog").showModal();
  $("pin-dialog-input").focus();
}

function replaceLink(updated, oldCode) {
  const i = links.findIndex((x) => x.code === oldCode);
  if (i >= 0) links[i] = updated;
  pinTarget = updated;
  render();
}

$("pin-dialog-close").addEventListener("click", () => $("pin-dialog").close());
$("pin-dialog-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const msg = $("pin-dialog-msg");
  const pin = $("pin-dialog-input").value;
  msg.className = "msg err";
  if (!isValidPin(pin)) return (msg.textContent = "The PIN must be exactly 6 digits.");
  $("pin-dialog-save").disabled = true;
  msg.className = "msg";
  msg.textContent = "Saving…";
  try {
    replaceLink(await client.update(pinTarget.code, { pin }), pinTarget.code);
    pinShown = pin;
    msg.textContent = "";
    paintPinDialog();
    toast(pinTarget.locked ? "PIN saved" : "Link unlocked");
  } catch (err) {
    msg.className = "msg err";
    msg.textContent = describeError(err, base);
  } finally {
    $("pin-dialog-save").disabled = false;
  }
});
$("pin-dialog-remove").addEventListener("click", async () => {
  if (!removeArmed) {
    // Removing the lock opens the link to everyone, so confirm with a second click.
    removeArmed = true;
    paintPinDialog();
    removeTimer = setTimeout(() => { removeArmed = false; paintPinDialog(); }, 4000);
    return;
  }
  clearTimeout(removeTimer);
  removeArmed = false;
  try {
    replaceLink(await client.update(pinTarget.code, { pin: null }), pinTarget.code);
    $("pin-dialog").close();
    toast("Lock removed. Anyone with the link can open it.");
  } catch (err) {
    $("pin-dialog-msg").className = "msg err";
    $("pin-dialog-msg").textContent = describeError(err, base);
    paintPinDialog();
  }
});
$("pin-dialog-copy").addEventListener("click", async () => {
  const ok = await copyText(`${base}/${pinTarget.code}\nPIN: ${pinShown}`);
  toast(ok ? "Link and PIN copied" : "Could not copy", ok ? "" : "err");
});

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
$("qr-png").addEventListener("click", async () => downloadBlob(await qrPngBlob(`${base}/${qrLink.code}`, 1024), `lfc-tools-${slug(qrLink.code)}-qr.png`));
$("qr-svg").addEventListener("click", () => downloadBlob(qrSvgBlob(`${base}/${qrLink.code}`), `lfc-tools-${slug(qrLink.code)}-qr.svg`));

// ------------------------------------------------------------ toolbar & misc

$("search").addEventListener("input", () => { view.query = $("search").value; render(); });
$("sort").addEventListener("change", () => { view.sort = $("sort").value; render(); });
$("lock-filter").addEventListener("change", () => { view.lock = $("lock-filter").value; render(); });
$("select-all").addEventListener("change", () => {
  const list = visible();
  if ($("select-all").checked) list.forEach((l) => selected.add(l.code));
  else list.forEach((l) => selected.delete(l.code));
  render();
});
$("export").addEventListener("click", () => {
  const stamp = new Date().toISOString().slice(0, 10);
  downloadBlob(new Blob([toCsv(visible(), base)], { type: "text/csv;charset=utf-8" }), `lfc-tools-links-${stamp}.csv`);
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

$("error-google").addEventListener("click", async () => {
  $("error-google").disabled = true;
  try {
    await signInWithGoogle();
    location.reload();
  } catch (err) {
    $("error-text").textContent = err instanceof AuthError ? err.message : "Sign-in failed. Try again.";
    $("error-google").disabled = false;
  }
});
$("signout").addEventListener("click", async () => {
  await signOut();
  location.reload();
});

(async function init() {
  mountIcons();
  const conn = await connect();
  base = conn.base;
  if (!conn.client) {
    loadState = "error";
    $("error-text").textContent = conn.authEnabled
      ? `Sign in with your @${conn.domain} Google account to manage your links.`
      : "Add your API key in settings to manage your links.";
    $("error-google").hidden = !conn.authEnabled;
    $("error-settings").textContent = conn.authEnabled ? "Use an API key instead" : "Open settings";
    $("error").hidden = false;
    $("retry").hidden = true;
    document.body.classList.add("disconnected");
    return;
  }
  client = conn.client;
  if (conn.email) {
    $("who").textContent = conn.email;
    $("who").hidden = false;
    $("signout").hidden = false;
  }
  await load();
})();
