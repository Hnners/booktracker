// Book Tracker front end - plain JavaScript, no build step.
const view = document.getElementById("view");
const modal = document.getElementById("modal");
const modalBody = document.getElementById("modal-body");

// ---------------------------------------------------------------- utilities
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else if (k === "style") el.style.cssText = v;
    else if (k === "value") el.value = v;
    else if (v === true) el.setAttribute(k, "");
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
  return el;
}
async function api(path, opts = {}) {
  const init = { ...opts, headers: {} };
  if (opts.body && !(opts.body instanceof FormData)) {
    init.body = JSON.stringify(opts.body);
    init.headers["Content-Type"] = "application/json";
  }
  const r = await fetch("/api" + path, init);
  if (!r.ok) {
    let msg = r.statusText;
    try { msg = (await r.json()).detail || msg; } catch {}
    throw new Error(msg);
  }
  return r.json();
}
let toastTimer;
function toast(msg, kind = "") {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.className = "show " + kind;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = ""), kind === "error" ? 6000 : 3200);
}
const fail = (e) => toast(e.message || String(e), "error");
const setView = (...kids) => view.replaceChildren(...kids.flat(Infinity).filter((k) => k != null && k !== false));
function openModal(...kids) {
  modalBody.replaceChildren(...kids.flat(Infinity).filter((k) => k != null && k !== false));
  if (!modal.open) modal.showModal();
}
function closeModal() { if (modal.open) modal.close(); }
modal.addEventListener("click", (e) => { if (e.target === modal) closeModal(); });
const closeBtn = () => h("button", { class: "btn quiet close", type: "button", "aria-label": "Close", onclick: closeModal }, "✕");
const plural = (n, one, many = one + "s") => `${n.toLocaleString("en-GB")} ${n === 1 ? one : many}`;
const store = {
  get(k, d) { try { const v = localStorage.getItem("bt_" + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("bt_" + k, JSON.stringify(v)); } catch {} },
};
function hashCode(s) { let x = 0; for (const c of s || "") x = (x * 31 + c.charCodeAt(0)) | 0; return Math.abs(x); }
function pickFile(accept, capture) {
  return new Promise((resolve) => {
    const inp = h("input", { type: "file", accept, capture, style: "display:none" });
    inp.addEventListener("change", () => { resolve(inp.files[0] || null); inp.remove(); });
    document.body.append(inp);
    inp.click();
  });
}
function loadScript(src) {
  return new Promise((ok, bad) => {
    if (document.querySelector(`script[src="${src}"]`)) return ok();
    const s = h("script", { src });
    s.onload = ok; s.onerror = () => bad(new Error("Couldn't load " + src));
    document.head.append(s);
  });
}

// ---------------------------------------------------------------- the library in memory
let BOOKS = [], CASES = [], SERIES = {};
async function loadAll() {
  [BOOKS, CASES, SERIES] = await Promise.all([api("/books"), api("/bookcases"), api("/series-info")]);
}
const bookById = (id) => BOOKS.find((b) => b.id === +id);
const caseById = (id) => CASES.find((c) => c.id === +id);
function upsert(b) {
  const i = BOOKS.findIndex((x) => x.id === b.id);
  if (i >= 0) BOOKS[i] = b; else BOOKS.push(b);
  return b;
}
const owned = () => BOOKS.filter((b) => b.status === "owned");
const wished = () => BOOKS.filter((b) => b.status === "wishlist");

const FORMATS = { "paperback": "Paperback", "large-paperback": "Large paperback", "mass-market": "Mass-market paperback",
  "hardback": "Hardback", "ebook": "eBook", "audiobook": "Audiobook" };
const SHELVABLE = { has: (f) => f !== "ebook" && f !== "audiobook" };     // anything you can put on a shelf
const READ = { unread: "Not read yet", reading: "Reading", read: "Read" };
const PRIORITY = { 1: "Really want", 2: "Would like", 3: "Some day" };
const WOODS = { oak: "Oak", walnut: "Walnut", pine: "Pine", white: "White", black: "Black", grey: "Grey" };

const PARTICLES = new Set(["le", "la", "de", "du", "da", "di", "van", "von", "der", "den", "del", "st", "st."]);
function nameParts(name) {
  const p = (name || "").replace(/,?\s+(jr|sr|ii|iii|iv)\.?$/i, "").split(/\s+/).filter(Boolean);
  let i = p.length - 1;
  while (i > 0 && PARTICLES.has(p[i - 1].toLowerCase())) i--;
  return { first: p.slice(0, Math.max(i, 0)).join(" "), last: p.slice(Math.max(i, 0)).join(" ") };
}
const authorKey = (name) => { const { first, last } = nameParts(name); return last ? (last + " " + first).toLowerCase() : "~"; };
const authorsText = (b) => b.authors.length ? b.authors.join(" & ") : "Unknown author";
const titleKey = (t) => (t || "").toLowerCase().replace(/^(the|a|an)\s+/, "");
const seriesText = (b) => b.series ? `${b.series}${b.series_no != null ? " #" + fmtNo(b.series_no) : ""}` : "";
const fmtNo = (n) => Number.isInteger(+n) ? String(+n) : String(+n);
function placeText(b) {
  if (b.status === "wishlist") return "On the wishlist";
  if (!SHELVABLE.has(b.format)) return `${FORMATS[b.format]} (not on a shelf)`;
  const c = b.bookcase_id != null && caseById(b.bookcase_id);
  return c ? `${c.name} · shelf ${b.shelf + 1}` : "To shelve";
}
const byAuthor = (a, b) => (authorKey(a.authors[0]).localeCompare(authorKey(b.authors[0])) ||
  (a.series || "").localeCompare(b.series || "") || (a.series_no || 0) - (b.series_no || 0) ||
  (a.year || "").localeCompare(b.year || "") || titleKey(a.title).localeCompare(titleKey(b.title)));
const SORTS = {
  author: byAuthor,
  title: (a, b) => titleKey(a.title).localeCompare(titleKey(b.title)),
  added: (a, b) => (b.added_at || "").localeCompare(a.added_at || "") || b.id - a.id,
  series: (a, b) => ((a.series || "~").localeCompare(b.series || "~") || (a.series_no || 0) - (b.series_no || 0) || byAuthor(a, b)),
};
function matches(b, q) {
  if (!q) return true;
  const hay = [b.title, b.subtitle, ...b.authors, b.series, b.isbn, b.publisher].join(" ").toLowerCase();
  return q.toLowerCase().split(/\s+/).every((w) => hay.includes(w));
}

// ---------------------------------------------------------------- covers and spines
const CLOTH = ["#6d2b34", "#2c3e5c", "#2f4f3a", "#8a6d2b", "#4a4a52", "#7a4b2a", "#3b5a63", "#5b3a5e", "#a2967c", "#1f2a30", "#8c3b2e", "#cfc4a8"];
function lum(hex) {
  const c = (hex || "#888888").replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => { const v = parseInt(c.slice(i, i + 2), 16) / 255; return v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; });
  return .2126 * r + .7152 * g + .0722 * b;
}
const inkFor = (bg) => lum(bg) > .32 ? "#1d1a17" : "#f7f2e8";
const spineBg = (b) => b.spine_colour || CLOTH[hashCode(b.title) % CLOTH.length];

function spineEl(b, scale) {
  const w = Math.max(5, b.thickness * scale), ht = b.height * scale;
  const bg = spineBg(b), ink = inkFor(bg);
  const acc = b.spine_accent && Math.abs(lum(b.spine_accent) - lum(bg)) > .08 ? b.spine_accent : ink;
  const el = h("button", {
    class: `spine look-${b.id % 4}${b.format === "hardback" ? " hard" : ""}${b.spine_url ? " photo" : ""}`,
    type: "button", "data-id": b.id, title: `${b.title} — ${authorsText(b)}`,
    style: `width:${w.toFixed(1)}px;height:${ht.toFixed(1)}px;--bg:${bg};--ink:${ink};--acc:${acc};--acc-ink:${inkFor(acc)}`,
  });
  if (b.spine_url) el.append(h("img", { src: b.spine_url, alt: "", loading: "lazy", draggable: "false" }));
  else if (w >= 10) {
    const fs = Math.max(6.5, Math.min(14, w * .42, ht / 16));
    el.append(h("span", { class: "spine-text", style: `font-size:${fs.toFixed(1)}px` },
      h("span", { class: "spine-title" }, b.title),
      b.authors[0] && ht > 90 ? h("span", { class: "spine-author" }, nameParts(b.authors[0]).last) : null));
  }
  el.setAttribute("aria-label", `${b.title} by ${authorsText(b)}`);
  return el;
}
function coverEl(b, cls = "cover") {
  if (b.cover_url) {
    const img = h("img", { src: b.cover_url, alt: "", loading: "lazy" });
    return h("div", { class: cls }, img);
  }
  const bg = spineBg(b);
  return h("div", { class: cls + " made", style: `--bg:${bg};--ink:${inkFor(bg)}` },
    h("span", { class: "made-title" }, b.title), h("span", { class: "made-author" }, authorsText(b)));
}
function bookTile(b, extra) {
  return h("button", { class: "tile" + (b.status === "wishlist" ? " wished" : ""), type: "button", onclick: () => openBook(b.id) },
    coverEl(b),
    b.status === "wishlist" ? h("span", { class: "ribbon" }, "Wishlist") : null,
    b.read_status === "read" ? h("span", { class: "read-mark", title: "Read" }, "✓") : null,
    h("span", { class: "tile-title" }, b.title),
    h("span", { class: "tile-sub" }, extra !== undefined ? extra : authorsText(b)));
}
const stars = (n) => n ? "★".repeat(n) + "☆".repeat(5 - n) : "";

// ---------------------------------------------------------------- router
const VIEWS = {};
let current = "";
function params() { return new URLSearchParams(location.hash.split("?")[1] || ""); }
async function route() {
  const name = (location.hash.slice(1).split("?")[0] || "bookcases");
  const fn = VIEWS[name] || VIEWS.bookcases;
  document.querySelectorAll(".tabs a").forEach((a) => a.toggleAttribute("aria-current", a.dataset.tab === name));
  if (name !== current) window.scrollTo(0, 0);
  current = name;
  try { await fn(params()); } catch (e) { fail(e); }
}
async function rerender() {
  const y = window.scrollY;
  await route();
  window.scrollTo(0, y);
}
// Always show the latest: books added on another phone or tab appear when you change page
// or come back to the app.
let lastLoad = Date.now();
async function fresh() {
  if (Date.now() - lastLoad < 2000) return;
  try { await loadAll(); lastLoad = Date.now(); } catch {}
}
window.addEventListener("hashchange", async () => { stopScanner(); await fresh(); route(); });
document.addEventListener("visibilitychange", async () => {
  if (document.visibilityState !== "visible" || modal.open || document.querySelector(".sortable-chosen")) return;
  await fresh(); rerender();
});
const pageHead = (title, sub, ...actions) =>
  h("div", { class: "head" }, h("div", {}, h("h1", {}, title), sub ? h("div", { class: "stats" }, sub) : null),
    actions.length ? h("div", { class: "row" }, actions) : null);
const stat = (n, label) => h("div", {}, h("b", {}, n.toLocaleString("en-GB")), h("span", {}, label));
const empty = (title, text, ...actions) => h("div", { class: "empty" }, h("h2", {}, title), h("p", { class: "muted" }, text), h("div", { class: "row" }, actions));

// ---------------------------------------------------------------- Bookcases
let sortables = [];
VIEWS.bookcases = function (p) {
  sortables.forEach((s) => s.destroy());
  sortables = [];
  const mine = owned();
  const tray = mine.filter((b) => b.bookcase_id == null && SHELVABLE.has(b.format)).sort(SORTS.added);
  const shelved = mine.filter((b) => b.bookcase_id != null);
  const digital = mine.filter((b) => !SHELVABLE.has(b.format)).length;
  const zoom = store.get("zoom", 1);
  const avail = Math.min(view.clientWidth || 360, 1320) - 48;
  // Two bookcases side by side on anything wider than a phone. Every bookcase is drawn at
  // the same scale, so a narrower one really looks narrower.
  const twoCols = window.innerWidth >= 720 && CASES.length > 1;
  const colW = twoCols ? (avail - 32) / 2 : avail;
  const widest = Math.max(600, ...CASES.map((c) => c.width_cm * 10));
  const fit = Math.max(.3, Math.min(1.05, (colW - 28) / widest));
  const scaleFor = () => fit * zoom;
  const find = h("input", { type: "search", placeholder: "Where's that book? Type a title or author", "aria-label": "Find a book on the shelves",
    oninput: () => highlight(find.value) });
  const zoomBtn = (d, label) => h("button", { class: "btn", type: "button", "aria-label": label, title: label,
    onclick: () => { store.set("zoom", Math.max(.5, Math.min(2.5, +(zoom * d).toFixed(2)))); rerender(); } }, d > 1 ? "+" : "−");

  const parts = [pageHead("Our bookcases",
    [stat(shelved.length, "on the shelves"), stat(tray.length, "to shelve"), stat(CASES.length, CASES.length === 1 ? "bookcase" : "bookcases")],
    h("button", { class: "btn primary", type: "button", onclick: () => editCase() }, "+ Bookcase"))];
  if (!CASES.length) {
    parts.push(empty("Build your first bookcase",
      "Measure the inside width of a shelf and count the shelves. Books are drawn to scale, so the app knows when a shelf is full.",
      h("button", { class: "btn primary", type: "button", onclick: () => editCase() }, "Add a bookcase"),
      h("a", { class: "btn", href: "#add" }, "Add books first")));
  } else {
    parts.push(h("div", { class: "controls" }, find, h("div", { class: "row zoom" }, zoomBtn(1 / 1.25, "Zoom out"), zoomBtn(1.25, "Zoom in"))));
    const wall = h("div", { class: "wall" + (twoCols ? " two" : "") }, CASES.map((c) => caseEl(c, scaleFor(c), mine)));
    wall.addEventListener("click", spineClick);
    parts.push(wall);
  }
  const trayScale = CASES.length ? scaleFor(CASES[0]) : .8;
  const trayBox = h("div", { class: "tray-books", "data-case": "" }, tray.map((b) => spineEl(b, trayScale)));
  trayBox.addEventListener("click", spineClick);
  parts.push(h("section", { class: "tray" },
    h("div", { class: "tray-head" },
      h("div", {}, h("h2", {}, "To shelve"),
        h("p", { class: "muted" }, tray.length ? "Drag these onto a shelf, or let the app shelve them for you." : "Nothing waiting. New books land here until they're put on a shelf."),
        digital ? h("p", { class: "muted small" }, `${plural(digital, "eBook or audiobook", "eBooks and audiobooks")} not shown, as they don't go on shelves. Change a book's format if it's really a printed copy.`) : null),
      tray.length && CASES.length ? h("button", { class: "btn", type: "button", onclick: () => arrangeDialog(null) }, "Shelve them for me…") : null),
    trayBox));
  setView(...parts);

  // dragging between shelves (hold for a moment on a phone)
  for (const el of view.querySelectorAll(".shelf-books, .tray-books")) {
    sortables.push(new Sortable(el, { group: "books", animation: 150, delay: 220, delayOnTouchOnly: true,
      ghostClass: "spine-ghost", chosenClass: "spine-chosen",
      onEnd: (e) => { if (e.from !== e.to || e.oldIndex !== e.newIndex) saveOrder(e.from, e.to); } }));
  }
  const focus = p.get("find");
  if (focus) {
    const s = view.querySelector(`.spine[data-id="${focus}"]`);
    if (s) { s.classList.add("found"); setTimeout(() => s.scrollIntoView({ block: "center", inline: "center", behavior: "smooth" }), 80); }
  }
};
function spineClick(e) {
  const s = e.target.closest(".spine");
  if (s) openBook(+s.dataset.id);
}
function highlight(q) {
  const spines = view.querySelectorAll(".spine");
  let first = null;
  for (const s of spines) {
    const hit = q.trim() && matches(bookById(s.dataset.id), q.trim());
    s.classList.toggle("found", !!hit);
    s.classList.toggle("dim", !!q.trim() && !hit);
    if (hit && !first) first = s;
  }
  if (first) first.scrollIntoView({ block: "center", inline: "center", behavior: "smooth" });
}
function caseEl(c, scale, mine) {
  const onCase = mine.filter((b) => b.bookcase_id === c.id);
  const shelves = [];
  for (let s = 0; s < c.shelves; s++) {
    const books = onCase.filter((b) => b.shelf === s).sort((a, b) => (a.shelf_pos || 0) - (b.shelf_pos || 0));
    const used = books.reduce((t, b) => t + b.thickness, 0);
    const over = used > c.width_cm * 10;
    shelves.push(h("div", { class: "shelf" + (over ? " over" : ""), style: `height:${(c.shelf_height_cm * 10 * scale).toFixed(0)}px` },
      h("div", { class: "shelf-books", "data-case": c.id, "data-shelf": s }, books.map((b) => spineEl(b, scale)))),
      h("div", { class: "plank" }, h("span", { class: "fill", title: "Used shelf space" },
        over ? `Over by ${((used - c.width_cm * 10) / 10).toFixed(0)} cm` : `${Math.round(used / 10)} of ${c.width_cm} cm`)));
  }
  return h("section", { class: `case wood-${c.wood || "oak"}`, "data-case": c.id },
    h("div", { class: "case-head" },
      h("div", {}, h("h2", {}, c.name), h("span", { class: "muted" }, plural(onCase.length, "book"))),
      h("div", { class: "row" },
        h("button", { class: "btn quiet", type: "button", onclick: () => arrangeDialog(c) }, "Arrange"),
        h("button", { class: "btn quiet", type: "button", onclick: () => editCase(c) }, "Edit"))),
    h("div", { class: "case-frame", style: `width:${(c.width_cm * 10 * scale + 28).toFixed(0)}px` }, shelves));
}
async function saveOrder(from, to) {
  const lists = [...new Set([from, to])].map((el) => {
    const ids = [...el.querySelectorAll(".spine")].map((s) => +s.dataset.id);
    const caseId = el.dataset.case === "" ? null : +el.dataset.case;
    const shelf = caseId == null ? null : +el.dataset.shelf;
    ids.forEach((id, i) => Object.assign(bookById(id), { bookcase_id: caseId, shelf, shelf_pos: caseId == null ? null : i + 1 }));
    return { bookcase_id: caseId, shelf, ids };
  });
  try {
    await api("/arrange", { method: "POST", body: { lists } });
  } catch (e) { fail(e); await loadAll(); }
  if (current === "bookcases") rerender();
}
function editCase(c) {
  const isNew = !c;
  c = c || { name: CASES.length ? "" : "Living room", shelves: 5, width_cm: 80, shelf_height_cm: 30, wood: "oak" };
  const f = {
    name: h("input", { value: c.name, required: true, placeholder: "e.g. Lounge, Bedroom left" }),
    shelves: h("input", { type: "number", min: 1, max: 20, value: c.shelves, inputmode: "numeric" }),
    width_cm: h("input", { type: "number", min: 10, max: 400, step: .5, value: c.width_cm, inputmode: "decimal" }),
    shelf_height_cm: h("input", { type: "number", min: 10, max: 80, step: .5, value: c.shelf_height_cm, inputmode: "decimal" }),
  };
  let wood = c.wood || "oak";
  const woods = h("div", { class: "woods", role: "radiogroup", "aria-label": "Finish" }, Object.entries(WOODS).map(([id, label]) =>
    h("button", { type: "button", class: `wood-chip wood-${id}`, role: "radio", "aria-checked": String(id === wood), onclick: (e) => {
      wood = id; woods.querySelectorAll("button").forEach((b) => b.setAttribute("aria-checked", String(b === e.currentTarget)));
    } }, label)));
  const save = async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(Object.entries(f).map(([k, el]) => [k, el.value]));
    body.wood = wood;
    try {
      if (isNew) await api("/bookcases", { method: "POST", body });
      else {
        if (+body.shelves < c.shelves && owned().some((b) => b.bookcase_id === c.id && b.shelf >= +body.shelves) &&
          !confirm("Books on the shelves you're removing will go back to 'To shelve'. Carry on?")) return;
        await api(`/bookcases/${c.id}`, { method: "PATCH", body });
      }
      await loadAll(); closeModal(); toast(isNew ? "Bookcase added" : "Bookcase saved"); rerender();
    } catch (err) { fail(err); }
  };
  const del = async () => {
    if (!confirm(`Delete ${c.name}? Its books stay in your library and go back to 'To shelve'.`)) return;
    try { await api(`/bookcases/${c.id}`, { method: "DELETE" }); await loadAll(); closeModal(); rerender(); } catch (err) { fail(err); }
  };
  openModal(h("form", { class: "form", onsubmit: save },
    h("div", { class: "modal-head" }, h("h2", {}, isNew ? "New bookcase" : `Edit ${c.name}`), closeBtn()),
    h("label", { class: "field" }, "Name", f.name),
    h("div", { class: "grid-3" },
      h("label", { class: "field" }, "Shelves", f.shelves),
      h("label", { class: "field" }, "Shelf width (cm, inside)", f.width_cm),
      h("label", { class: "field" }, "Shelf height (cm)", f.shelf_height_cm)),
    h("div", { class: "field" }, h("span", {}, "Finish"), woods),
    h("p", { class: "muted small" }, "Shelves are numbered from the top. A typical paperback is about 2 cm thick, so an 80 cm shelf holds around 35–40."),
    h("div", { class: "row end" },
      isNew ? null : h("button", { class: "btn danger", type: "button", onclick: del }, "Delete bookcase"),
      h("button", { class: "btn primary", type: "submit" }, isNew ? "Add bookcase" : "Save"))));
  setTimeout(() => f.name.focus(), 50);
}
function arrangeDialog(c) {
  const fromTray = !c;
  const target = h("select", {}, CASES.map((x) => h("option", { value: x.id, selected: c && x.id === c.id }, x.name)));
  const source = h("select", {},
    h("option", { value: "tray", selected: fromTray }, "Add the books waiting in 'To shelve'"),
    h("option", { value: "case", selected: !fromTray }, "Re-sort everything already in this bookcase"));
  const order = h("select", {}, Object.entries({ author: "By author (then series, in order)", series: "By series", title: "By title",
    colour: "By colour (a rainbow shelf)", height: "Tallest to shortest" }).map(([v, l]) => h("option", { value: v }, l)));
  order.value = store.get("arrange", "author");
  const go = async (e) => {
    e.preventDefault();
    store.set("arrange", order.value);
    try {
      const r = await api(`/bookcases/${target.value}/fill`, { method: "POST", body: { order: order.value, source: source.value } });
      await loadAll(); closeModal(); rerender();
      toast(r.left ? `${plural(r.placed, "book")} shelved; ${r.left} didn't fit` : `${plural(r.placed, "book")} shelved`);
    } catch (err) { fail(err); }
  };
  openModal(h("form", { class: "form", onsubmit: go },
    h("div", { class: "modal-head" }, h("h2", {}, "Arrange books"), closeBtn()),
    h("label", { class: "field" }, "Bookcase", target),
    h("label", { class: "field" }, "What to arrange", source),
    h("label", { class: "field" }, "Order", order),
    h("p", { class: "muted small" }, "Books fill each shelf from the top until it's full, using each book's thickness. You can drag any of them afterwards."),
    h("div", { class: "row end" }, h("button", { class: "btn primary", type: "submit" }, "Arrange"))));
}

// ---------------------------------------------------------------- Library
VIEWS.library = function () {
  const st = store.get("lib", { q: "", show: "all", sort: "author" });
  const mine = owned();
  const read = mine.filter((b) => b.read_status === "read").length;
  const q = h("input", { type: "search", value: st.q, placeholder: "Search title, author, series, ISBN", "aria-label": "Search the library" });
  const show = h("select", { "aria-label": "Show" }, Object.entries({ all: "All our books", unread: "Not read yet", reading: "Reading now",
    read: "Read", unshelved: "To shelve", digital: "eBooks & audiobooks", nocover: "Missing a cover" }).map(([v, l]) => h("option", { value: v }, l)));
  const sort = h("select", { "aria-label": "Sort" }, Object.entries({ author: "Author", title: "Title", added: "Recently added", series: "Series" })
    .map(([v, l]) => h("option", { value: v }, l)));
  show.value = st.show; sort.value = st.sort;
  const grid = h("div", { class: "grid" });
  const count = h("p", { class: "muted count" });
  const draw = () => {
    store.set("lib", { q: q.value, show: show.value, sort: sort.value });
    const tests = { all: () => true, unread: (b) => b.read_status === "unread", reading: (b) => b.read_status === "reading",
      read: (b) => b.read_status === "read", unshelved: (b) => SHELVABLE.has(b.format) && b.bookcase_id == null,
      digital: (b) => !SHELVABLE.has(b.format), nocover: (b) => !b.cover_url };
    const list = mine.filter((b) => tests[show.value](b) && matches(b, q.value.trim())).sort(SORTS[sort.value]);
    grid.replaceChildren(...list.map((b) => bookTile(b, sort.value === "series" && b.series ? seriesText(b) : authorsText(b))));
    count.textContent = list.length === mine.length ? "" : `Showing ${list.length} of ${mine.length}`;
  };
  q.addEventListener("input", draw); show.addEventListener("change", draw); sort.addEventListener("change", draw);
  setView(
    pageHead("Library", [stat(mine.length, "books"), stat(read, "read"), stat(new Set(mine.flatMap((b) => b.authors)).size, "authors")],
      h("a", { class: "btn primary", href: "#add" }, "+ Add books")),
    mine.length ? h("div", { class: "controls" }, q, show, sort) : empty("No books yet", "Scan a barcode or search by title to add your first book.",
      h("a", { class: "btn primary", href: "#add" }, "Add books"), h("a", { class: "btn", href: "#more" }, "Import from Goodreads")),
    count, grid);
  draw();
};

// ---------------------------------------------------------------- Authors
VIEWS.authors = function () {
  const groups = new Map();
  for (const b of BOOKS) for (const a of (b.authors.length ? b.authors : ["Unknown author"])) {
    const key = a.toLowerCase();
    if (!groups.has(key)) groups.set(key, { name: a, books: [] });
    groups.get(key).books.push(b);
  }
  const authors = [...groups.values()].sort((x, y) => authorKey(x.name).localeCompare(authorKey(y.name)));
  const letterOf = (a) => { const l = authorKey(a.name)[0]?.toUpperCase() || "#"; return /[A-Z]/.test(l) ? l : "#"; };
  const q = h("input", { type: "search", placeholder: "Find an author", "aria-label": "Find an author" });
  const ownedOnly = h("input", { type: "checkbox", checked: store.get("auth_owned", false) });
  const list = h("div", { class: "authors" });
  const jump = h("nav", { class: "jump", "aria-label": "Jump to letter" });
  const draw = () => {
    store.set("auth_owned", ownedOnly.checked);
    const shown = authors.map((a) => ({ ...a, books: a.books.filter((b) => !ownedOnly.checked || b.status === "owned") }))
      .filter((a) => a.books.length && (!q.value.trim() || a.name.toLowerCase().includes(q.value.trim().toLowerCase())));
    const letters = [...new Set(shown.map(letterOf))];
    jump.replaceChildren(...letters.map((l) => h("a", { href: `#authors`, onclick: (e) => { e.preventDefault(); document.getElementById("letter-" + l)?.scrollIntoView({ behavior: "smooth" }); } }, l)));
    let last = null;
    list.replaceChildren(...shown.flatMap((a) => {
      const l = letterOf(a);
      const mark = l !== last ? h("h3", { class: "letter", id: "letter-" + l }, l) : null;
      last = l;
      const books = a.books.sort((x, y) => ((x.series || "~").localeCompare(y.series || "~") || (x.series_no || 0) - (y.series_no || 0) || (x.year || "").localeCompare(y.year || "")));
      const own = books.filter((b) => b.status === "owned"), wish = books.length - own.length;
      const readN = own.filter((b) => b.read_status === "read").length;
      const seriesNames = [...new Set(books.map((b) => b.series).filter(Boolean))];
      return [mark, h("section", { class: "author" },
        h("div", { class: "author-head" }, h("h2", {}, a.name),
          h("span", { class: "muted" }, [plural(own.length, "book"), readN ? `${readN} read` : null, wish ? `${wish} on the wishlist` : null,
            seriesNames.length ? plural(seriesNames.length, "series", "series") : null].filter(Boolean).join(" · "))),
        h("div", { class: "strip" }, books.map((b) => bookTile(b, b.series ? seriesText(b) : (b.year || "")))))];
    }));
  };
  q.addEventListener("input", draw); ownedOnly.addEventListener("change", draw);
  setView(
    pageHead("Authors", [stat(authors.length, "authors")]),
    BOOKS.length ? h("div", { class: "controls" }, q, h("label", { class: "check" }, ownedOnly, "Only books we own")) :
      empty("No authors yet", "Authors appear here as you add books.", h("a", { class: "btn primary", href: "#add" }, "Add books")),
    jump, list);
  draw();
};

// ---------------------------------------------------------------- Series
VIEWS.series = function () {
  const groups = new Map();
  for (const b of BOOKS) if (b.series) {
    const key = b.series.toLowerCase();
    if (!groups.has(key)) groups.set(key, { name: b.series, books: [] });
    groups.get(key).books.push(b);
  }
  const totalOf = (s) => {
    const known = Object.entries(SERIES).find(([k]) => k.toLowerCase() === s.name.toLowerCase());
    return known ? known[1] : null;
  };
  const all = [...groups.values()].map((s) => {
    const nos = s.books.map((b) => b.series_no).filter((n) => n != null && Number.isInteger(+n) && n > 0);
    const known = totalOf(s);
    const total = known || (nos.length ? Math.max(...nos) : 0);
    const ownedNos = new Set(s.books.filter((b) => b.status === "owned").map((b) => +b.series_no));
    const missing = [];
    for (let n = 1; n <= total; n++) if (!ownedNos.has(n)) missing.push(n);
    return { ...s, total, known: !!known, missing, authors: [...new Set(s.books.flatMap((b) => b.authors))] };
  }).sort((a, b) => a.name.localeCompare(b.name));
  const filter = h("select", { "aria-label": "Show" }, h("option", { value: "all" }, "All series"),
    h("option", { value: "gaps" }, "With books missing"), h("option", { value: "done" }, "Complete"));
  filter.value = store.get("series_filter", "all");
  const q = h("input", { type: "search", placeholder: "Find a series", "aria-label": "Find a series" });
  const list = h("div", { class: "series-list" });
  const draw = () => {
    store.set("series_filter", filter.value);
    const shown = all.filter((s) => (filter.value === "all" || (filter.value === "gaps" ? s.missing.length || !s.known : s.known && !s.missing.length)) &&
      (!q.value.trim() || (s.name + " " + s.authors.join(" ")).toLowerCase().includes(q.value.trim().toLowerCase())));
    list.replaceChildren(...shown.map(seriesCard));
  };
  filter.addEventListener("change", draw); q.addEventListener("input", draw);
  setView(
    pageHead("Series", [stat(all.length, "series"), stat(all.filter((s) => s.known && !s.missing.length).length, "complete")]),
    all.length ? h("div", { class: "controls" }, q, filter) :
      empty("No series yet", "Books found online usually come with their series. You can also type a series and number on any book.",
        h("a", { class: "btn", href: "#library" }, "Go to the library")),
    list);
  draw();
};
function seriesCard(s) {
  const slots = [];
  const used = new Set();
  for (let n = 1; n <= s.total; n++) {
    const here = s.books.filter((b) => +b.series_no === n).sort((a, b) => (a.status === "owned" ? -1 : 1));
    let run = 0;
    while (!here.length && n + run + 1 <= s.total && !s.books.some((b) => +b.series_no === n + run + 1)) run++;
    if (run >= 3) {
      const from = n, to = n + run;
      slots.push(h("button", { class: "tile missing", type: "button", onclick: () => location.hash = `#add?q=${encodeURIComponent(`${s.name} ${s.authors[0] || ""}`)}&to=wishlist` },
        h("div", { class: "cover gap" }, h("span", { class: "range" }, `#${from}–${to}`), h("small", {}, "Find them")),
        h("span", { class: "tile-title" }, `${run + 1} missing`), h("span", { class: "tile-sub" }, `Books ${from} to ${to}`)));
      n = to;
      continue;
    }
    if (here.length) { here.forEach((b) => used.add(b.id)); slots.push(bookTile(here[0], `#${n}`)); }
    else slots.push(h("button", { class: "tile missing", type: "button", title: "Find it and add it to the wishlist",
      onclick: () => { ADD_CONTEXT = { series: s.name, series_no: n }; location.hash = `#add?q=${encodeURIComponent(`${s.name} ${n} ${s.authors[0] || ""}`)}&to=wishlist`; } },
      h("div", { class: "cover gap" }, h("span", {}, `#${n}`), h("small", {}, "Find it")), h("span", { class: "tile-title" }, "Missing"), h("span", { class: "tile-sub" }, `Book ${n}`)));
  }
  for (const b of s.books.filter((b) => !used.has(b.id)).sort((a, b) => (a.series_no || 999) - (b.series_no || 999)))
    slots.push(bookTile(b, b.series_no != null ? `#${fmtNo(b.series_no)}` : "No number"));
  const ownedN = s.books.filter((b) => b.status === "owned").length;
  const done = s.known && !s.missing.length;
  return h("section", { class: "series-card" + (done ? " done" : "") },
    h("div", { class: "series-head" },
      h("div", {}, h("h2", {}, s.name), h("span", { class: "muted" }, s.authors.join(", "))),
      h("div", { class: "row" },
        !s.known ? h("button", { class: "btn small", type: "button", onclick: () => editSeries(s) }, `${plural(ownedN, "book")} · how many in the series?`) :
        s.total ? h("span", { class: "progress", title: `${s.total - s.missing.length} of ${s.total}` },
          h("span", { class: "bar" }, h("span", { style: `width:${Math.round(100 * (s.total - s.missing.length) / s.total)}%` })),
          done ? "Complete" : `${s.total - s.missing.length} of ${s.total}`) : h("span", { class: "muted" }, plural(ownedN, "book")),
        h("button", { class: "btn quiet", type: "button", onclick: () => editSeries(s) }, "Edit"))),
    h("div", { class: "strip" }, slots));
}
function editSeries(s) {
  const total = h("input", { type: "number", min: 0, max: 500, value: Object.entries(SERIES).find(([k]) => k.toLowerCase() === s.name.toLowerCase())?.[1] || "", placeholder: String(s.total || ""), inputmode: "numeric" });
  const name = h("input", { value: s.name });
  const save = async (e) => {
    e.preventDefault();
    try {
      if (name.value.trim() && name.value.trim() !== s.name) await api("/series/rename", { method: "POST", body: { old: s.name, new: name.value.trim() } });
      await api("/series-info", { method: "PUT", body: { name: name.value.trim() || s.name, total: total.value } });
      await loadAll(); closeModal(); rerender();
    } catch (err) { fail(err); }
  };
  openModal(h("form", { class: "form", onsubmit: save },
    h("div", { class: "modal-head" }, h("h2", {}, s.name), closeBtn()),
    h("label", { class: "field" }, "Series name", name),
    h("label", { class: "field" }, "How many books are in the series?", total),
    h("p", { class: "muted small" }, "With this set, the app shows which numbers you're missing, even ones after the last book you have. Leave it blank to count up to your highest number."),
    h("div", { class: "row end" }, h("button", { class: "btn primary", type: "submit" }, "Save"))));
}

// ---------------------------------------------------------------- Wishlist
VIEWS.wishlist = function () {
  const list = wished();
  const sections = [1, 2, 3].map((p) => {
    const books = list.filter((b) => (b.wish_priority || 2) === p).sort(byAuthor);
    if (!books.length) return null;
    return h("section", { class: "wish-group" }, h("h2", {}, PRIORITY[p], h("span", { class: "muted" }, ` · ${books.length}`)),
      h("div", { class: "grid" }, books.map((b) => h("div", { class: "wish" }, bookTile(b, b.wish_note || authorsText(b)),
        h("button", { class: "btn small got", type: "button", onclick: () => gotIt(b) }, "Got it!")))));
  });
  const copy = async () => {
    const text = list.sort(byAuthor).map((b) => `${b.title}${b.series ? ` (${seriesText(b)})` : ""} — ${authorsText(b)}${b.isbn ? ` — ISBN ${b.isbn}` : ""}`).join("\n");
    try { await navigator.clipboard.writeText(text); toast("Wishlist copied, ready to paste into a message"); }
    catch { openModal(h("div", { class: "modal-head" }, h("h2", {}, "Wishlist"), closeBtn()), h("textarea", { rows: 14, readonly: true }, text)); }
  };
  setView(
    pageHead("Wishlist", [stat(list.length, "books we'd like")],
      list.length ? h("button", { class: "btn", type: "button", onclick: copy }, "Copy the list") : null,
      h("a", { class: "btn primary", href: "#add?to=wishlist" }, "+ Add to wishlist")),
    list.length ? sections : empty("Nothing on the wishlist", "Search for a book or scan one in a shop, then add it to the wishlist. Gaps in a series can be added from the Series page.",
      h("a", { class: "btn primary", href: "#add?to=wishlist" }, "Find a book")));
};
async function gotIt(b) {
  try {
    upsert(await api(`/books/${b.id}/got-it`, { method: "POST" }));
    toast(`${b.title} is in the library, waiting to be shelved`);
    closeModal(); rerender();
  } catch (e) { fail(e); }
}

// ---------------------------------------------------------------- Add books
let ADD_CONTEXT = null;      // set by a missing series book: books added get that series and number
const recentlyAdded = [];
function placeOptions(selected) {
  const opts = [h("option", { value: "" }, "To shelve")];
  for (const c of CASES) for (let s = 0; s < c.shelves; s++)
    opts.push(h("option", { value: `${c.id}:${s}` }, `${c.name} — shelf ${s + 1}${s === 0 ? " (top)" : s === c.shelves - 1 ? " (bottom)" : ""}`));
  const sel = h("select", {}, opts);
  sel.value = selected || "";
  return sel;
}
const parsePlace = (v) => v ? { bookcase_id: +v.split(":")[0], shelf: +v.split(":")[1] } : {};
VIEWS.add = function (p) {
  let to = p.get("to") || store.get("add_to", "owned");
  if (to !== "wishlist") to = "owned";
  const place = placeOptions(store.get("add_place", ""));
  place.addEventListener("change", () => store.set("add_place", place.value));
  const placeRow = h("label", { class: "field place" }, "Put it on", place);
  const seg = h("div", { class: "seg", role: "radiogroup", "aria-label": "Add to" }, [["owned", "Our library"], ["wishlist", "Wishlist"]].map(([v, l]) =>
    h("button", { type: "button", role: "radio", "aria-checked": String(v === to), onclick: () => { to = v; store.set("add_to", v); syncSeg(); } }, l)));
  const syncSeg = () => { seg.querySelectorAll("button").forEach((b, i) => b.setAttribute("aria-checked", String(["owned", "wishlist"][i] === to))); placeRow.hidden = to !== "owned"; };
  const isbn = h("input", { inputmode: "numeric", placeholder: "ISBN, e.g. 978 0 14 143951 8", "aria-label": "ISBN", autocomplete: "off" });
  const q = h("input", { type: "search", placeholder: "Title, author, or both", "aria-label": "Search for a book", value: p.get("q") || "" });
  const results = h("div", { class: "results", "aria-live": "polite" });
  const recent = h("div", { class: "recent" });
  const target = () => ({ status: to, ...(to === "owned" ? parsePlace(place.value) : {}), ...(ADD_CONTEXT || {}) });

  const showRecent = () => recent.replaceChildren(...(recentlyAdded.length ? [h("h2", {}, "Just added"),
    ...recentlyAdded.slice(0, 12).map((b) => h("div", { class: "recent-row" }, coverEl(b, "thumb"),
      h("div", {}, h("strong", {}, b.title), h("div", { class: "muted small" }, `${authorsText(b)} · ${placeText(b)}`)),
      h("div", { class: "row" },
        h("button", { class: "btn small", type: "button", onclick: () => openBook(b.id) }, "Edit"),
        h("button", { class: "btn small quiet", type: "button", onclick: async () => {
          try { await api(`/books/${b.id}`, { method: "DELETE" }); BOOKS = BOOKS.filter((x) => x.id !== b.id);
            recentlyAdded.splice(recentlyAdded.indexOf(b), 1); showRecent(); toast("Removed"); } catch (e) { fail(e); } } }, "Undo"))))] : []));

  const add = async (data, status, btn) => {
    if (btn) btn.disabled = true;
    try {
      const body = { ...data, ...target(), status, lookup: !!data.isbn && !data.full };
      if (status !== "owned") { delete body.bookcase_id; delete body.shelf; }
      const b = upsert(await api("/books", { method: "POST", body }));
      recentlyAdded.unshift(b); showRecent();
      if (ADD_CONTEXT) { ADD_CONTEXT = null; view.querySelector(".notice.context")?.remove(); }
      toast(`Added ${b.title}${status === "wishlist" ? " to the wishlist" : ""}`);
      return b;
    } catch (e) { fail(e); if (btn) btn.disabled = false; }
  };
  const resultCard = (r) => {
    const have = r.have || haveIsbn(r.isbn)?.status;
    const known = haveIsbn(r.isbn);
    return h("div", { class: "result" },
      r.cover_preview ? h("div", { class: "thumb" }, h("img", { src: r.cover_preview, alt: "", loading: "lazy", onerror: (e) => e.target.parentNode.classList.add("none") })) : h("div", { class: "thumb none" }),
      h("div", { class: "result-body" },
        h("strong", {}, r.title, r.subtitle ? h("span", { class: "muted" }, `: ${r.subtitle}`) : null),
        h("div", { class: "muted small" }, [(r.authors || []).join(" & ") || "Unknown author", r.publisher, r.year, r.series ? seriesText(r) : null, r.pages ? `${r.pages} pages` : null].filter(Boolean).join(" · ")),
        r.isbn ? h("div", { class: "muted small" }, `ISBN ${r.isbn}`) : null,
        have ? h("div", { class: "have" }, have === "owned" ? `Already in the library${known ? " · " + placeText(known) : ""}` : "Already on the wishlist") : null),
      h("div", { class: "result-actions" },
        h("button", { class: "btn small" + (to === "owned" ? " primary" : ""), type: "button", onclick: (e) => add(r, "owned", e.currentTarget) }, "Add to library"),
        h("button", { class: "btn small" + (to === "wishlist" ? " primary" : ""), type: "button", onclick: (e) => add(r, "wishlist", e.currentTarget) }, "Wishlist")));
  };
  const busy = (text) => results.replaceChildren(h("p", { class: "muted loading" }, text));
  const doIsbn = async (e) => {
    e?.preventDefault();
    if (!isbn.value.trim()) return;
    busy("Looking it up…");
    try {
      const r = await api(`/lookup?isbn=${encodeURIComponent(isbn.value)}`);
      if (!r.found) {
        results.replaceChildren(h("div", { class: "notice" }, h("p", {}, `Nothing found online for ${r.isbn}.`),
          h("button", { class: "btn", type: "button", onclick: () => byHand({ isbn: r.isbn }) }, "Add it by hand")));
        return;
      }
      results.replaceChildren(resultCard(r.found));
      isbn.value = "";
    } catch (err) { results.replaceChildren(h("p", { class: "error" }, err.message)); }
  };
  const doSearch = async (e) => {
    e?.preventDefault();
    if (q.value.trim().length < 2) return;
    busy("Searching…");
    try {
      const list = await api(`/search?q=${encodeURIComponent(q.value.trim())}`);
      results.replaceChildren(...(list.length ? list.map(resultCard) : [h("p", { class: "muted" }, "Nothing found. Try fewer words, or add it by hand.")]),
        h("p", { class: "muted small" }, "Not the right one? ", h("button", { class: "linkish", type: "button", onclick: () => byHand({ title: q.value.trim() }) }, "Add it by hand")));
    } catch (err) { results.replaceChildren(h("p", { class: "error" }, err.message)); }
  };
  const byHand = (seed = {}) => openBook(null, { ...seed, ...target(), status: to });

  setView(
    pageHead("Add books"),
    ADD_CONTEXT ? h("div", { class: "notice context" }, h("span", {}, `Looking for ${ADD_CONTEXT.series} #${ADD_CONTEXT.series_no}. Whatever you add gets that series and number.`),
      h("button", { class: "btn small quiet", type: "button", onclick: () => { ADD_CONTEXT = null; rerender(); } }, "Stop")) : null,
    h("div", { class: "add-to" }, h("span", { class: "muted" }, "Add to"), seg, placeRow),
    h("div", { class: "add-grid" },
      h("section", { class: "panel" },
        h("h2", {}, "Scan or type an ISBN"),
        h("p", { class: "muted small" }, "It's the barcode on the back, starting 978 or 979. Scanning is quickest for a whole shelf: keep scanning and each book is added in order."),
        h("button", { class: "btn primary big", type: "button", onclick: () => openScanner({ to: () => to, target, add, onDone: showRecent }) }, "📷  Scan barcodes"),
        h("form", { class: "row inline-form", onsubmit: doIsbn }, isbn, h("button", { class: "btn", type: "submit" }, "Look up"))),
      h("section", { class: "panel" },
        h("h2", {}, "Search"),
        h("p", { class: "muted small" }, "No barcode to hand? Search Google Books and Open Library."),
        h("form", { class: "row inline-form", onsubmit: doSearch }, q, h("button", { class: "btn", type: "submit" }, "Search")),
        h("button", { class: "linkish small", type: "button", onclick: () => byHand() }, "Or add a book by hand"))),
    results, recent);
  syncSeg(); showRecent();
  if (p.get("q")) doSearch();
};
const haveIsbn = (isbn) => isbn ? BOOKS.find((b) => b.isbn === isbn) : null;

// ---------------------------------------------------------------- barcode scanner
let scanStop = null;
function stopScanner() { if (scanStop) { try { scanStop(); } catch {} scanStop = null; } }
modal.addEventListener("close", stopScanner);
function beep(ok = true) {
  try {
    const ctx = beep.ctx || (beep.ctx = new (window.AudioContext || window.webkitAudioContext)());
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.value = ok ? 1320 : 330; g.gain.value = .08;
    o.connect(g).connect(ctx.destination); o.start(); o.stop(ctx.currentTime + (ok ? .09 : .25));
  } catch {}
  try { navigator.vibrate?.(ok ? 60 : [80, 60, 80]); } catch {}
}
async function startCamera(video, onCode) {
  if ("BarcodeDetector" in window) {
    let formats = [];
    try { formats = await BarcodeDetector.getSupportedFormats(); } catch {}
    if (formats.includes("ean_13")) {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 } }, audio: false });
      video.srcObject = stream;
      await video.play();
      const det = new BarcodeDetector({ formats: ["ean_13"] });
      let on = true;
      const loop = async () => {
        if (!on) return;
        try { for (const c of await det.detect(video)) onCode(c.rawValue); } catch {}
        setTimeout(loop, 160);
      };
      loop();
      return () => { on = false; stream.getTracks().forEach((t) => t.stop()); };
    }
  }
  await loadScript("/static/vendor/zxing.min.js");       // iPhones and Firefox
  const hints = new Map([[ZXing.DecodeHintType.POSSIBLE_FORMATS, [ZXing.BarcodeFormat.EAN_13]]]);
  const reader = new ZXing.BrowserMultiFormatReader(hints, 160);
  await reader.decodeFromConstraints({ video: { facingMode: { ideal: "environment" } }, audio: false }, video, (res) => { if (res) onCode(res.getText()); });
  return () => reader.reset();
}
function openScanner({ to, target, add, onDone }) {
  const video = h("video", { playsinline: true, muted: true, autoplay: true });
  const status = h("p", { class: "scan-status" }, "Starting the camera…");
  const keep = h("input", { type: "checkbox", checked: store.get("keep_scanning", true) });
  keep.addEventListener("change", () => store.set("keep_scanning", keep.checked));
  const log = h("ol", { class: "scan-log", reversed: true });
  const seen = new Map();
  let busy = false;
  const line = (text, cls = "") => { log.prepend(h("li", { class: cls }, text)); };
  const handle = async (raw) => {
    const code = (raw || "").replace(/\D/g, "");
    if (!/^97[89]\d{10}$/.test(code)) return;                 // not a book barcode
    if (busy || Date.now() - (seen.get(code) || 0) < 4000) return;
    seen.set(code, Date.now());
    busy = true;
    status.textContent = `Found ${code}, looking it up…`;
    try {
      const r = await api(`/lookup?isbn=${code}`);
      const mine = r.have.find((b) => b.status === "owned");
      if (mine) {
        beep(false);
        status.textContent = `We already have ${mine.title}`;
        line(h("span", {}, h("strong", {}, mine.title), ` — already ours (${placeText(mine)})`), "dup");
      } else if (!r.found) {
        beep(false);
        status.textContent = `Couldn't find ${code} online`;
        line(h("span", {}, `${code}: not found online. `, h("button", { class: "linkish", type: "button", onclick: () => { stopScanner(); openBook(null, { isbn: code, ...target(), status: to() }); } }, "Add by hand")), "miss");
      } else if (keep.checked) {
        const b = await add({ ...r.found }, to());
        if (b) { beep(); status.textContent = `Added ${b.title}. Next one…`; line(h("span", {}, h("strong", {}, b.title), ` — ${authorsText(b)}`), "ok"); }
      } else {
        beep();
        stopScanner(); closeModal();
        const b = await add({ ...r.found }, to());
        if (b) openBook(b.id);
      }
    } catch (e) { status.textContent = e.message; }
    busy = false;
  };
  openModal(
    h("div", { class: "modal-head" }, h("h2", {}, "Scan barcodes"), closeBtn()),
    h("div", { class: "scanner" }, video, h("div", { class: "scan-guide", "aria-hidden": "true" })),
    status,
    h("div", { class: "row between" }, h("label", { class: "check" }, keep, "Keep scanning (adds each book straight away)"),
      h("button", { class: "btn primary", type: "button", onclick: () => { closeModal(); onDone && onDone(); } }, "Done")),
    log);
  modal.classList.add("wide");
  modal.addEventListener("close", () => modal.classList.remove("wide"), { once: true });
  if (!window.isSecureContext || !navigator.mediaDevices) {
    status.textContent = "The camera only works when the app is opened over https:// (your books.… address), not the http:// local one. You can still type ISBNs.";
    return;
  }
  startCamera(video, handle).then((stop) => { scanStop = stop; status.textContent = "Point the camera at a barcode"; })
    .catch((e) => { status.textContent = e.name === "NotAllowedError" ? "The camera is blocked. Allow it for this site in your browser settings." : `Couldn't start the camera: ${e.message}`; });
}

// ---------------------------------------------------------------- one book
function openBook(id, seed) {
  const isNew = id == null;
  const b = isNew ? { title: "", authors: [], format: "paperback", read_status: "unread", status: "owned", wish_priority: 2, ...seed, thickness: 21, height: 198 } : bookById(id);
  if (!b) return;
  const field = (label, el, cls = "") => h("label", { class: "field " + cls }, label, el);
  const f = {
    title: h("input", { value: b.title, required: true }),
    subtitle: h("input", { value: b.subtitle || "" }),
    authors: h("input", { value: (b.authors || []).join(" & "), placeholder: "e.g. Terry Pratchett & Neil Gaiman" }),
    series: h("input", { value: b.series || "", list: "series-names" }),
    series_no: h("input", { type: "number", step: .5, min: 0, value: b.series_no ?? "", inputmode: "decimal" }),
    format: h("select", {}, Object.entries(FORMATS).map(([v, l]) => h("option", { value: v }, l))),
    pages: h("input", { type: "number", min: 1, value: b.pages || "", inputmode: "numeric" }),
    isbn: h("input", { value: b.isbn || "", inputmode: "numeric" }),
    publisher: h("input", { value: b.publisher || "" }),
    year: h("input", { value: b.year || "", inputmode: "numeric", maxlength: 4 }),
    notes: h("textarea", { rows: 3 }, b.notes || ""),
    height_mm: h("input", { type: "number", min: 50, max: 500, value: b.height_mm || "", placeholder: String(Math.round(b.height)), inputmode: "numeric" }),
    thickness_mm: h("input", { type: "number", min: 2, max: 150, step: .5, value: b.thickness_mm || "", placeholder: String(Math.round(b.thickness)), inputmode: "decimal" }),
    wish_priority: h("select", {}, Object.entries(PRIORITY).map(([v, l]) => h("option", { value: v }, l))),
    wish_note: h("input", { value: b.wish_note || "", placeholder: "e.g. the hardback edition, Waterstones £12" }),
  };
  f.format.value = b.format || "paperback";
  f.wish_priority.value = String(b.wish_priority || 2);
  let readStatus = b.read_status || "unread", rating = b.rating || 0;
  const readSeg = h("div", { class: "seg", role: "radiogroup", "aria-label": "Read" }, Object.entries(READ).map(([v, l]) =>
    h("button", { type: "button", role: "radio", "aria-checked": String(v === readStatus), onclick: (e) => {
      readStatus = v; readSeg.querySelectorAll("button").forEach((x) => x.setAttribute("aria-checked", String(x === e.currentTarget)));
    } }, l)));
  const starBox = h("div", { class: "stars", role: "radiogroup", "aria-label": "Rating" });
  const drawStars = () => starBox.replaceChildren(...[1, 2, 3, 4, 5].map((n) => h("button", { type: "button", role: "radio", "aria-checked": String(n === rating),
    "aria-label": `${n} star${n > 1 ? "s" : ""}`, class: n <= rating ? "on" : "", onclick: () => { rating = rating === n ? 0 : n; drawStars(); } }, "★")));
  drawStars();
  const placeSel = placeOptions(b.bookcase_id != null ? `${b.bookcase_id}:${b.shelf}` : (seed && seed.bookcase_id != null ? `${seed.bookcase_id}:${seed.shelf}` : ""));
  const startPlace = placeSel.value;
  const datalist = h("datalist", { id: "series-names" }, [...new Set(BOOKS.map((x) => x.series).filter(Boolean))].sort().map((s) => h("option", { value: s })));

  const gather = () => {
    const body = { read_status: readStatus, rating: rating || null };
    for (const [k, el] of Object.entries(f)) body[k] = el.value.trim ? el.value.trim() : el.value;
    if (b.status !== "wishlist") { delete body.wish_priority; delete body.wish_note; }
    return body;
  };
  const save = async (e) => {
    e.preventDefault();
    const body = gather();
    try {
      let saved;
      if (isNew) {
        saved = await api("/books", { method: "POST", body: { ...body, status: b.status, lookup: false, ...(b.status === "owned" ? parsePlace(placeSel.value) : {}), cover_urls: seed?.cover_urls } });
        recentlyAdded.unshift(saved);
      } else {
        if (b.status === "owned" && placeSel.value !== startPlace) body.place = placeSel.value ? parsePlace(placeSel.value) : null;
        saved = await api(`/books/${b.id}`, { method: "PATCH", body });
      }
      upsert(saved); closeModal(); toast(isNew ? `Added ${saved.title}` : "Saved"); rerender();
    } catch (err) { fail(err); }
  };

  // pictures
  const coverBox = h("div", { class: "detail-cover" }, coverEl(b, "cover big"));
  const spineBox = h("div", { class: "detail-spine" }, isNew ? null : spineEl(b, 1.1));
  const refresh = (nb) => {
    upsert(nb); Object.assign(b, nb);
    coverBox.replaceChildren(coverEl(nb, "cover big"));
    spineBox.replaceChildren(spineEl(nb, 1.1));
    spineTools.replaceChildren(...spineButtons());
  };
  const upload = async (path, file) => {
    if (!file) return;
    const fd = new FormData(); fd.append("file", file);
    toast("Uploading…");
    try { refresh(await api(path, { method: "POST", body: fd })); toast("Picture saved"); } catch (err) { fail(err); }
  };
  const spineButtons = () => [
    h("button", { class: "btn small", type: "button", onclick: async () => upload(`/books/${b.id}/spine`, await pickFile("image/*", "environment")) }, b.spine_url ? "New spine photo" : "Photo of the spine"),
    b.spine_url ? h("button", { class: "btn small", type: "button", title: "Turn it upside down", onclick: async () => { try { refresh(await api(`/books/${b.id}/spine/rotate?degrees=180`, { method: "POST" })); } catch (err) { fail(err); } } }, "↻ Flip") : null,
    b.spine_url ? h("button", { class: "btn small quiet", type: "button", onclick: async () => { try { refresh(await api(`/books/${b.id}/spine`, { method: "DELETE" })); } catch (err) { fail(err); } } }, "Use drawn spine") : null,
  ];
  const spineTools = h("div", { class: "row tools" }, spineButtons());

  const actions = isNew ? [] : [
    b.status === "wishlist" ? h("button", { class: "btn got", type: "button", onclick: () => gotIt(b) }, "Got it!") : null,
    b.status === "owned" && b.bookcase_id != null ? h("a", { class: "btn", href: `#bookcases?find=${b.id}`, onclick: closeModal }, "Show on the shelf") : null,
    b.status === "owned" ? h("button", { class: "btn quiet", type: "button", onclick: async () => {
      try { upsert(await api(`/books/${b.id}`, { method: "PATCH", body: { status: "wishlist" } })); closeModal(); toast("Moved to the wishlist"); rerender(); } catch (err) { fail(err); } } }, "Move to wishlist") : null,
    h("button", { class: "btn danger quiet", type: "button", onclick: async () => {
      if (!confirm(`Delete ${b.title} from ${b.status === "wishlist" ? "the wishlist" : "your library"}?`)) return;
      try { await api(`/books/${b.id}`, { method: "DELETE" }); BOOKS = BOOKS.filter((x) => x.id !== b.id); closeModal(); toast("Deleted"); rerender(); } catch (err) { fail(err); } } }, "Delete"),
  ];

  openModal(h("form", { class: "form book-form", onsubmit: save },
    h("div", { class: "modal-head" }, h("div", {}, h("h2", {}, isNew ? (b.status === "wishlist" ? "Add to the wishlist" : "Add a book") : b.title),
      isNew ? null : h("p", { class: "muted" }, [authorsText(b), seriesText(b), placeText(b)].filter(Boolean).join(" · "))), closeBtn()),
    h("div", { class: "book-grid" },
      h("div", { class: "book-pics" },
        coverBox,
        isNew ? h("p", { class: "muted small" }, "You can add a cover photo once it's saved.") : h("div", { class: "row tools" },
          h("button", { class: "btn small", type: "button", onclick: () => chooseCover(b) }, "Choose edition"),
          h("button", { class: "btn small", type: "button", onclick: async () => upload(`/books/${b.id}/cover`, await pickFile("image/*", "environment")) }, "Cover photo"),
          b.isbn ? h("button", { class: "btn small quiet", type: "button", onclick: async (e) => {
            e.currentTarget.disabled = true;
            try { const r = await api(`/books/${b.id}/refresh`, { method: "POST" }); refresh(r.book);
              toast(r.cover ? "Found a cover" + (r.filled.length ? " and filled in some details" : "") : r.filled.length ? "Filled in some details" : "Nothing new found"); }
            catch (err) { fail(err); } e.currentTarget.disabled = false; } }, "Look up again") : null),
        isNew ? null : h("div", { class: "spine-preview" }, h("span", { class: "muted small" }, "Spine"), spineBox, spineTools)),
      h("div", { class: "book-fields" },
        field("Title", f.title),
        field("Subtitle", f.subtitle),
        field("Author(s)", f.authors),
        h("div", { class: "grid-2 series-row" }, field("Series", f.series), field("Number", f.series_no, "narrow")),
        datalist,
        b.status === "owned" ? h("div", { class: "grid-2" }, field("Where it lives", placeSel), field("Format", f.format)) :
          h("div", { class: "grid-2" }, field("How much we want it", f.wish_priority), field("Format", f.format)),
        b.status === "wishlist" ? field("Wishlist note", f.wish_note) : null,
        h("div", { class: "field" }, h("span", {}, "Read?"), readSeg),
        h("div", { class: "field" }, h("span", {}, "Rating"), starBox),
        field("Notes", f.notes),
        h("details", {}, h("summary", {}, "Edition details"),
          h("div", { class: "grid-2" }, field("ISBN", f.isbn), field("Pages", f.pages), field("Publisher", f.publisher), field("Year", f.year),
            field("Spine height (mm)", f.height_mm), field("Thickness (mm)", f.thickness_mm)),
          h("p", { class: "muted small" }, "Height and thickness are worked out from the format and page count. Set them to draw this spine exactly.")),
        b.description ? h("details", {}, h("summary", {}, "Description"), h("p", { class: "desc" }, b.description)) : null)),
    h("div", { class: "row end sticky-actions" }, actions, h("button", { class: "btn primary", type: "submit" }, isNew ? "Add" : "Save"))));
  modal.classList.add("wide");
  modal.addEventListener("close", () => modal.classList.remove("wide"), { once: true });
  if (isNew) setTimeout(() => f.title.focus(), 50);
}

// Switch a book to another edition (or just take its cover): this ISBN first, then the
// other English editions, UK ones first
async function chooseCover(b) {
  const grid = h("div", { class: "cover-choices" }, h("p", { class: "muted loading" }, "Finding editions…"));
  const coverOnly = h("input", { type: "checkbox" });
  openModal(h("div", { class: "modal-head" }, h("div", {}, h("h2", {}, "Choose the edition"),
    h("p", { class: "muted" }, "Pick the one that matches your copy. Its title, ISBN and publisher replace this book's.")),
    h("button", { class: "btn quiet close", type: "button", "aria-label": "Back", onclick: () => openBook(b.id) }, "✕")),
    h("label", { class: "check small", style: "margin-bottom:12px" }, coverOnly, "Only change the cover"), grid);
  const pick = async (c, btn) => {
    grid.querySelectorAll("button").forEach((x) => (x.disabled = true));
    btn.classList.add("picked");
    try {
      if (c.edition && !coverOnly.checked) {
        const body = Object.fromEntries(Object.entries(c.edition).filter(([, v]) => v != null && v !== ""));
        if (Object.keys(body).length) upsert(await api(`/books/${b.id}`, { method: "PATCH", body }));
      }
      const fd = new FormData(); fd.append("url", c.url);
      upsert(await api(`/books/${b.id}/cover`, { method: "POST", body: fd }));
      toast(c.edition && !coverOnly.checked ? "Switched to that edition" : "Cover changed");
      openBook(b.id); rerender();
    } catch (err) { fail(err); grid.querySelectorAll("button").forEach((x) => (x.disabled = false)); }
  };
  try {
    const list = await api(`/books/${b.id}/covers`);
    grid.replaceChildren(...list.map((c) => h("button", { class: "cover-choice", type: "button", onclick: (e) => pick(c, e.currentTarget) },
      h("div", { class: "cover" }, h("img", { src: c.preview, alt: "", loading: "lazy", onerror: (e) => e.target.closest("button").remove() }),
        c.uk ? h("span", { class: "ribbon uk" }, "UK") : null),
      c.edition?.title && c.edition.title.toLowerCase() !== b.title.toLowerCase() ? h("span", { class: "tile-title" }, c.edition.title) : null,
      h("span", { class: "tile-sub" }, c.label))));
    if (!list.length) grid.replaceChildren(h("p", { class: "muted" }, "No other editions found. You can take a photo of the cover instead."));
  } catch (err) { grid.replaceChildren(h("p", { class: "error" }, err.message)); }
}

// ---------------------------------------------------------------- More: bookcases, import, export
VIEWS.more = function () {
  const file = h("input", { type: "file", accept: ".csv,text/csv" });
  const toRead = h("select", {}, h("option", { value: "wishlist" }, "Put them on the wishlist"),
    h("option", { value: "owned" }, "They're books we own, not read yet"), h("option", { value: "skip" }, "Leave them out"));
  const jobBox = h("div", { class: "job" });
  const noCover = BOOKS.filter((b) => !b.cover_url).length;
  const doImport = async (e) => {
    e.preventDefault();
    if (!file.files[0]) return toast("Choose the CSV file first");
    const fd = new FormData(); fd.append("file", file.files[0]); fd.append("to_read", toRead.value);
    try {
      const r = await api("/import", { method: "POST", body: fd });
      toast(`Imported ${plural(r.added, "book")}${r.skipped ? `, skipped ${r.skipped} already here` : ""}`);
      await loadAll();
      if (r.fetching) watchJob(jobBox);
    } catch (err) { fail(err); }
  };
  setView(
    pageHead("More"),
    h("div", { class: "more-grid" },
      h("section", { class: "panel" }, h("h2", {}, "Bookcases"),
        CASES.length ? h("ul", { class: "plain" }, CASES.map((c) => h("li", { class: "row between" },
          h("span", {}, h("strong", {}, c.name), h("span", { class: "muted" }, ` · ${c.shelves} shelves, ${c.width_cm} cm wide`)),
          h("button", { class: "btn small", type: "button", onclick: () => editCase(c) }, "Edit")))) : h("p", { class: "muted" }, "None yet."),
        h("button", { class: "btn", type: "button", onclick: () => editCase() }, "+ Add a bookcase")),
      h("section", { class: "panel" }, h("h2", {}, "Import from Goodreads"),
        h("p", { class: "muted small" }, "On goodreads.com: My Books → Import and export → Export library. Series in titles like 'Mort (Discworld, #4)' are picked up. This app's own CSV export works here too."),
        h("form", { class: "form", onsubmit: doImport }, file,
          h("label", { class: "field" }, "Books on the 'Want to read' shelf", toRead),
          h("button", { class: "btn primary", type: "submit" }, "Import")),
        jobBox),
      h("section", { class: "panel" }, h("h2", {}, "Covers"),
        h("p", { class: "muted small" }, noCover ? `${plural(noCover, "book")} without a cover. The app can look for them online; it takes a second or so per book.` : "Every book has a cover."),
        noCover ? h("button", { class: "btn", type: "button", onclick: async () => {
          try { await api("/fetch-missing", { method: "POST" }); watchJob(jobBox); } catch (err) { fail(err); } } }, "Find missing covers") : null),
      h("section", { class: "panel" }, h("h2", {}, "Export and backup"),
        h("p", { class: "muted small" }, "The CSV opens in Excel. The backup has everything, pictures included."),
        h("div", { class: "row" }, h("a", { class: "btn", href: "/api/export.csv" }, "Download CSV"), h("a", { class: "btn", href: "/api/backup" }, "Download backup")))));
  api("/job").then((j) => { if (j.running) watchJob(jobBox); });
};
async function watchJob(box) {
  let j;
  do {
    try { j = await api("/job"); } catch { return; }
    box.replaceChildren(h("p", { class: "small" }, `${j.label}: ${j.done} of ${j.total} · ${j.found} covers found`),
      h("progress", { max: j.total || 1, value: j.done }));
    if (j.running) await new Promise((r) => setTimeout(r, 1500));
  } while (j.running && document.body.contains(box));
  if (!j.running) { await loadAll(); box.replaceChildren(h("p", { class: "small" }, `Done: ${j.found} covers found.`)); }
}

// ---------------------------------------------------------------- start
let resizeTimer;
window.addEventListener("resize", () => {
  if (current !== "bookcases") return;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (!document.querySelector(".sortable-chosen")) rerender(); }, 250);
});
(async () => {
  try { await loadAll(); } catch (e) { fail(e); }
  route();
})();
