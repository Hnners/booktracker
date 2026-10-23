#!/usr/bin/env python3
"""
Book Tracker: a self-hosted home library. Books, their covers and spines, your bookcases
shelf by shelf, authors, series and a wishlist.

Run (inside the venv):  uvicorn app:app --host 0.0.0.0 --port 8000
Then open http://<container-ip>:8000 from any device on your network.
"""
import csv
import hashlib
import io
import json
import os
import re
import shutil
import sqlite3
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from datetime import datetime
from pathlib import Path

from fastapi import BackgroundTasks, FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from PIL import Image, ImageOps, ImageStat

HERE = Path(__file__).parent
HOME = Path(os.environ.get("BOOKTRACKER_HOME", HERE))     # where your books live (never in git)
DB = HOME / "books.db"
COVERS = HOME / "covers"
SPINES = HOME / "spines"
for d in (COVERS, SPINES):
    d.mkdir(parents=True, exist_ok=True)

# Where book details come from. Both are free and need no account.
OL = os.environ.get("OPENLIBRARY_URL", "https://openlibrary.org")
OL_COVERS = os.environ.get("OPENLIBRARY_COVERS_URL", "https://covers.openlibrary.org")
GB = os.environ.get("GOOGLE_BOOKS_URL", "https://www.googleapis.com/books/v1")
GB_KEY = os.environ.get("GOOGLE_BOOKS_KEY", "")          # optional; raises Google's daily limit
UA = "BookTracker/1.0 (self-hosted home library)"

# Sizes for drawing spines when a book doesn't say: spine height by format (mm)
FORMATS = {
    "paperback": ("Paperback", 198),        # UK B-format
    "large-paperback": ("Large paperback", 234),
    "mass-market": ("Mass-market paperback", 178),
    "hardback": ("Hardback", 240),
}                                           # printed books only: eBooks and audiobooks aren't logged
DIGITAL = ("ebook", "audiobook")
SHELVABLE = ("paperback", "large-paperback", "mass-market", "hardback")

app = FastAPI(title="Book Tracker")


# ---------------------------------------------------------------- database
def db():
    conn = sqlite3.connect(DB, timeout=30)
    conn.row_factory = sqlite3.Row
    return conn


def setup():
    with db() as c:
        c.execute("PRAGMA journal_mode=WAL")
        c.execute("""CREATE TABLE IF NOT EXISTS books (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            status TEXT NOT NULL DEFAULT 'owned',           -- owned | wishlist
            title TEXT NOT NULL, subtitle TEXT, authors TEXT NOT NULL DEFAULT '[]',
            isbn TEXT, publisher TEXT, year TEXT, pages INTEGER, format TEXT DEFAULT 'paperback',
            height_mm REAL, thickness_mm REAL,
            series TEXT, series_no REAL, description TEXT,
            cover TEXT, cover_urls TEXT, spine_photo TEXT, spine_colour TEXT, spine_accent TEXT,
            read_status TEXT DEFAULT 'unread', rating INTEGER, notes TEXT,
            bookcase_id INTEGER, shelf INTEGER, shelf_pos REAL,
            wish_priority INTEGER DEFAULT 2, wish_note TEXT,
            added_at TEXT, updated_at TEXT)""")
        cols = [r[1] for r in c.execute("PRAGMA table_info(books)")]
        for col in ("loaned_to", "loaned_at"):          # on loan: who to (optional) and since when
            if col not in cols:
                c.execute(f"ALTER TABLE books ADD COLUMN {col} TEXT")
        c.execute("CREATE INDEX IF NOT EXISTS books_isbn ON books(isbn)")
        c.execute("CREATE INDEX IF NOT EXISTS books_place ON books(bookcase_id, shelf, shelf_pos)")
        c.execute("""CREATE TABLE IF NOT EXISTS bookcases (
            id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
            shelves INTEGER NOT NULL DEFAULT 5, width_cm REAL NOT NULL DEFAULT 80,
            shelf_height_cm REAL NOT NULL DEFAULT 30, wood TEXT DEFAULT 'oak', pos INTEGER DEFAULT 0)""")
        c.execute("CREATE TABLE IF NOT EXISTS series_info (name TEXT PRIMARY KEY COLLATE NOCASE, total INTEGER)")


setup()
now = lambda: datetime.now().isoformat(timespec="seconds")


# ---------------------------------------------------------------- small helpers
def isbn13(raw):
    """Any ISBN-10 or ISBN-13 (with or without dashes) as ISBN-13, or None."""
    s = re.sub(r"[^0-9Xx]", "", str(raw or "")).upper()
    if len(s) == 10:
        if sum((10 - i) * (10 if ch == "X" else int(ch)) for i, ch in enumerate(s)) % 11:
            return None
        s = "978" + s[:9]
        return s + str((10 - sum((1 if i % 2 == 0 else 3) * int(d) for i, d in enumerate(s)) % 10) % 10)
    if len(s) == 13 and s.isdigit() and s[:3] in ("978", "979"):
        if sum((1 if i % 2 == 0 else 3) * int(d) for i, d in enumerate(s)) % 10 == 0:
            return s
    return None


SERIES_RE = re.compile(
    r"^(?P<name>.*?)[\s,;:(\-–—]*(?:#|no\.?|nr\.?|book|bk\.?|vol\.?|volume|part)?\s*(?P<no>\d+(?:\.\d+)?)\s*\)?\s*$", re.I)


def parse_series(text):
    """'Discworld (3)', 'Discworld, #3', 'Discworld -- 3', 'Discworld ; bk. 3' -> ('Discworld', 3.0)"""
    text = (text or "").strip().strip("()").strip()
    if not text:
        return None, None
    m = SERIES_RE.match(text)
    if m and m.group("name").strip(" ,;:-–—#"):
        return m.group("name").strip(" ,;:-–—#"), float(m.group("no"))
    return text, None


TITLE_SERIES_RE = re.compile(r"^(?P<title>.+?)\s*\((?P<series>[^()]+?),?\s*#(?P<no>\d+(?:\.\d+)?)\)\s*$")


def split_title_series(title):
    """Goodreads style 'Mort (Discworld, #4)' -> ('Mort', 'Discworld', 4.0)"""
    m = TITLE_SERIES_RE.match(title or "")
    if m:
        return m.group("title").strip(), m.group("series").strip(), float(m.group("no"))
    return title, None, None


def tidy_name(name):
    name = re.sub(r"\s+", " ", (name or "").strip())
    if name.count(",") == 1 and not re.search(r",\s*(jr|sr|ii|iii|iv)\.?$", name, re.I):
        last, first = [p.strip() for p in name.split(",")]
        if first and last:
            name = f"{first} {last}"
    return name


PARTICLES = {"le", "la", "de", "du", "da", "di", "van", "von", "der", "den", "del", "st", "st."}


def author_sort(name):
    parts = re.sub(r",?\s+(jr|sr|ii|iii|iv)\.?$", "", name or "", flags=re.I).split()
    if not parts:
        return ""
    i = len(parts) - 1
    while i > 0 and parts[i - 1].lower() in PARTICLES:
        i -= 1
    return (" ".join(parts[i:]) + " " + " ".join(parts[:i])).lower().strip()


def split_authors(text):
    if isinstance(text, list):
        return [tidy_name(a) for a in text if str(a).strip()]
    return [tidy_name(a) for a in re.split(r"\s*(?:;|&|\band\b|\|)\s*", text or "") if a.strip()]


def guess_format(text):
    t = (text or "").lower()
    if "mass" in t:
        return "mass-market"
    if any(w in t for w in ("hardcover", "hardback", "hard cover", "library binding")):
        return "hardback"
    if any(w in t for w in ("kindle", "ebook", "e-book", "epub")):
        return "ebook"
    if "audio" in t:
        return "audiobook"
    if any(w in t for w in ("trade", "large")):
        return "large-paperback"
    return "paperback" if "paper" in t or "soft" in t else None


def dims(b):
    """(height, thickness) in mm used to draw the spine and fill shelves."""
    fmt = b["format"] if b["format"] in FORMATS else "paperback"
    h = b["height_mm"] or FORMATS[fmt][1] or 198
    t = b["thickness_mm"]
    if not t:
        pages = b["pages"] or 320
        t = pages * 0.065 + (6 if fmt == "hardback" else 1)
    return round(h, 1), round(max(4, min(t, 120)), 1)


def book_out(r):
    b = dict(r)
    b["authors"] = json.loads(b["authors"] or "[]")
    b["author_sort"] = author_sort(b["authors"][0]) if b["authors"] else ""
    b["height"], b["thickness"] = dims(r)
    b["cover_url"] = f"/covers/{b['cover']}" if b["cover"] else None
    b["spine_url"] = f"/spines/{b['spine_photo']}" if b["spine_photo"] else None
    b.pop("cover_urls", None)
    return b


def get_book(c, book_id):
    r = c.execute("SELECT * FROM books WHERE id=?", (book_id,)).fetchone()
    if not r:
        raise HTTPException(404, "That book isn't in your library")
    return r


# ---------------------------------------------------------------- looking books up
def http_get(url, timeout=12, accept="application/json"):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": accept})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


LOOKUP_PROBLEMS = []     # what went wrong talking to Google / Open Library, newest last


def http_json(url, timeout=12):
    """JSON from a book service, or None. A service being down, slow or refusing us
    never breaks the app: the other one may still answer."""
    try:
        return json.loads(http_get(url, timeout))
    except urllib.error.HTTPError as e:
        if e.code != 404:
            problem = f"{urllib.parse.urlsplit(url).hostname} said {e.code} {e.reason}"
            if e.code == 429 and "googleapis" in url:
                problem += " (Google's daily limit; a free API key fixes this, see the README)"
            LOOKUP_PROBLEMS.append(problem)
            print("Lookup problem:", problem, url, flush=True)
        return None
    except (OSError, ValueError) as e:     # no internet, DNS, timeouts, SSL, bad JSON
        problem = f"couldn't reach {urllib.parse.urlsplit(url).hostname} ({e})"
        LOOKUP_PROBLEMS.append(problem)
        print("Lookup problem:", problem, flush=True)
        return None


def lookup_failed(what):
    """Nothing found and a service misbehaved: say so instead of 'nothing found'."""
    if LOOKUP_PROBLEMS:
        raise HTTPException(503, f"Couldn't {what}: {LOOKUP_PROBLEMS[-1]}. Try again in a minute.")


def strip_html(s):
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", s or "")).strip() or None


def from_openlibrary(isbn):
    ed = http_json(f"{OL}/isbn/{isbn}.json")
    if not ed:
        return {}
    out = {"title": ed.get("title"), "subtitle": ed.get("subtitle"),
           "publisher": (ed.get("publishers") or [None])[0]}
    m = re.search(r"\d{4}", ed.get("publish_date") or "")
    out["year"] = m.group(0) if m else None
    out["pages"] = ed.get("number_of_pages")
    if not out["pages"]:
        m = re.search(r"(\d+)\s*p", ed.get("pagination") or "")
        out["pages"] = int(m.group(1)) if m else None
    out["format"] = f if (f := guess_format(ed.get("physical_format"))) in FORMATS else None
    work = None
    author_keys = [a.get("key") for a in ed.get("authors") or [] if a.get("key")]
    if ed.get("works"):
        work = http_json(f"{OL}{ed['works'][0]['key']}.json") or {}
        if not author_keys:
            author_keys = [a.get("author", {}).get("key") for a in work.get("authors") or [] if a.get("author")]
    names = []
    for key in author_keys[:4]:
        a = http_json(f"{OL}{key}.json")
        if a and a.get("name"):
            names.append(tidy_name(a["name"]))
    out["authors"] = names
    desc = ed.get("description") or (work or {}).get("description")
    out["description"] = desc.get("value") if isinstance(desc, dict) else desc
    for s in (ed.get("series") or []) + ((work or {}).get("series") or []):
        name, no = parse_series(s if isinstance(s, str) else s.get("name", ""))
        if name:
            out["series"], out["series_no"] = name, no
            break
    if not out.get("series") and ed.get("works"):
        out["series"], out["series_no"] = series_from_other_editions(ed["works"][0]["key"])
    out["cover_urls"] = [f"{OL_COVERS}/b/id/{cid}-L.jpg" for cid in ed.get("covers") or [] if cid and cid > 0][:2]
    return out


def series_from_other_editions(work_key):
    """Many editions don't list their series, but other editions of the same book do.
    Take the series most of them agree on (preferring ones that give a number)."""
    data = http_json(f"{OL}{work_key}/editions.json?limit=100") or {}
    votes = {}
    for e in data.get("entries") or []:
        for s in e.get("series") or []:
            name, no = parse_series(s if isinstance(s, str) else s.get("name", ""))
            if name and len(name) < 80:
                key = (name, no)
                votes[key] = votes.get(key, 0) + (2 if no is not None else 1)
    if not votes:
        return None, None
    by_name = {}
    for (name, no), n in votes.items():
        by_name.setdefault(name.lower(), []).append((n, name, no))
    best = max(by_name.values(), key=lambda v: sum(x[0] for x in v))
    numbered = [x for x in best if x[2] is not None]
    n, name, no = max(numbered or best)
    return name, no


def gb_item(v):
    info = v.get("volumeInfo", {})
    ids = {i.get("type"): i.get("identifier") for i in info.get("industryIdentifiers") or []}
    isbn = isbn13(ids.get("ISBN_13") or ids.get("ISBN_10") or "")
    m = re.search(r"\d{4}", info.get("publishedDate") or "")
    out = {"isbn": isbn, "title": info.get("title"), "subtitle": info.get("subtitle"),
           "authors": [tidy_name(a) for a in info.get("authors") or []], "publisher": info.get("publisher"),
           "year": m.group(0) if m else None, "pages": info.get("pageCount") or None,
           "description": strip_html(info.get("description")), "cover_urls": []}
    links = info.get("imageLinks") or {}
    for size in ("extraLarge", "large", "medium", "thumbnail", "smallThumbnail"):
        if links.get(size):
            u = links[size].replace("http://", "https://").replace("&edge=curl", "")
            out["cover_urls"] = [u + "&fife=w800-h1200", u]
            break
    d = info.get("dimensions") or {}
    for key, field in (("height", "height_mm"), ("thickness", "thickness_mm")):
        m = re.match(r"([\d.]+)\s*cm", d.get(key) or "")
        if m:
            out[field] = round(float(m.group(1)) * 10, 1)
    return out


def from_google(isbn):
    data = http_json(f"{GB}/volumes?q=isbn:{isbn}" + (f"&key={GB_KEY}" if GB_KEY else ""))
    items = (data or {}).get("items") or []
    return gb_item(items[0]) if items else {}


def lookup_isbn(isbn):
    """Everything we can find about one ISBN, Google Books first (better for UK editions),
    Open Library to fill gaps (and it knows series)."""
    g, o = from_google(isbn), from_openlibrary(isbn)
    if not (g or o):
        return None
    out = {"isbn": isbn}
    for k in ("title", "subtitle", "authors", "publisher", "year", "pages", "description",
              "height_mm", "thickness_mm"):
        out[k] = g.get(k) or o.get(k)
    out["format"] = o.get("format")
    out["series"], out["series_no"] = o.get("series"), o.get("series_no")
    if not out["series"]:
        t, s, n = split_title_series(out["title"])
        if s:
            out["title"], out["series"], out["series_no"] = t, s, n
    out["cover_urls"] = (o.get("cover_urls") or []) + (g.get("cover_urls") or []) + \
        [f"{OL_COVERS}/b/isbn/{isbn}-L.jpg?default=false"]
    out["cover_preview"] = out["cover_urls"][0] if out["cover_urls"] else None
    out["full"] = True        # everything we could find; adding it needn't look it up again
    return out


LANG = os.environ.get("BOOK_LANGUAGE", "en")         # two letters: whose editions and covers to prefer
LANG3 = {"en": "eng", "fr": "fre", "de": "ger", "es": "spa", "it": "ita", "nl": "dut"}.get(LANG, "eng")


def search_books(q):
    """Find books by title / author / anything, English editions only, so the ISBN and
    cover that come back are for a copy you could actually have on your shelf."""
    results, seen = [], set()
    data = http_json(f"{GB}/volumes?q={urllib.parse.quote(q)}&maxResults=20&printType=books&langRestrict={LANG}"
                     + (f"&key={GB_KEY}" if GB_KEY else "")) or {}
    for v in data.get("items") or []:
        if (v.get("volumeInfo", {}).get("language") or LANG) != LANG:
            continue
        b = gb_item(v)
        if not b.get("title"):
            continue
        key = b["isbn"] or (b["title"].lower(), tuple(b["authors"][:1]))
        if key in seen:
            continue
        seen.add(key)
        b["cover_preview"] = b["cover_urls"][-1] if b["cover_urls"] else None
        b["source"] = "Google Books"
        results.append(b)
    # Open Library: ask for the best matching English edition of each work, not the work's
    # first ISBN and cover, which can be any language.
    data = http_json(f"{OL}/search.json?q={urllib.parse.quote(q + ' language:' + LANG3)}&lang={LANG}&limit=12"
                     "&fields=key,title,author_name,first_publish_year,number_of_pages_median,"
                     "editions,editions.key,editions.title,editions.isbn,editions.cover_i,editions.language") or {}
    for d in data.get("docs") or []:
        ed = ((d.get("editions") or {}).get("docs") or [{}])[0]
        if ed and LANG3 not in (ed.get("language") or [LANG3]):
            continue
        isbns = [i for i in (isbn13(x) for x in ed.get("isbn") or []) if i]
        isbn = isbns[0] if isbns else None
        title, authors = ed.get("title") or d.get("title"), [tidy_name(a) for a in d.get("author_name") or []][:3]
        if not title or (isbn and isbn in seen) or (title.lower(), tuple(authors[:1])) in seen:
            continue
        seen.update({isbn, (title.lower(), tuple(authors[:1]))})
        cover = f"{OL_COVERS}/b/id/{ed['cover_i']}-L.jpg" if ed.get("cover_i") else None
        results.append({"isbn": isbn, "title": title, "authors": authors, "year": str(d.get("first_publish_year") or "") or None,
                        "pages": d.get("number_of_pages_median"), "cover_urls": [cover] if cover else [],
                        "cover_preview": cover.replace("-L.", "-M.") if cover else None, "source": "Open Library"})
    return results[:24]


UK_PLACES = ("london", "uk", "united kingdom", "england", "edinburgh", "great britain", "oxford", "harmondsworth",
             "glasgow", "manchester", "cardiff", "dublin")


def edition_choices(r):
    """Editions to choose between for a book: this ISBN first, then the other English editions
    of the same book with a cover, UK ones first. Each carries its details so picking one can
    switch the book to that edition."""
    out, seen = [], set()

    def add(url, preview, **info):
        if url and url not in seen:
            seen.add(url)
            out.append({"url": url, "preview": preview or url, **info})

    work_key = None
    if r["isbn"]:
        g = from_google(r["isbn"])
        if g.get("cover_urls"):
            add(g["cover_urls"][0], g["cover_urls"][-1], label="This ISBN (Google Books)", current=True)
        ed = http_json(f"{OL}/isbn/{r['isbn']}.json") or {}
        for cid in ed.get("covers") or []:
            if cid and cid > 0:
                add(f"{OL_COVERS}/b/id/{cid}-L.jpg", f"{OL_COVERS}/b/id/{cid}-M.jpg", label="This ISBN (Open Library)", current=True)
        if ed.get("works"):
            work_key = ed["works"][0]["key"]
    if not work_key:
        author = (json.loads(r["authors"] or "[]") or [""])[0]
        hit = http_json(f"{OL}/search.json?q={urllib.parse.quote(r['title'] + ' ' + author)}&lang={LANG}&limit=1&fields=key") or {}
        work_key = ((hit.get("docs") or [{}])[0]).get("key")
    if not work_key:
        return out
    eds = http_json(f"{OL}{work_key}/editions.json?limit=300") or {}
    others = []
    for e in eds.get("entries") or []:
        langs = [l.get("key", "") for l in e.get("languages") or []]
        covers = [c for c in e.get("covers") or [] if c and c > 0]
        if not covers or (langs and f"/languages/{LANG3}" not in langs):
            continue
        places = ", ".join(e.get("publish_places") or [])
        uk = any(p in places.lower() for p in UK_PLACES)
        isbn = next((i for i in map(isbn13, (e.get("isbn_13") or []) + (e.get("isbn_10") or [])) if i), None)
        year = (re.findall(r"\d{4}", e.get("publish_date") or "") or [None])[0]
        publisher = (e.get("publishers") or [None])[0]
        others.append((not uk, not isbn, -(int(year) if year else 0), {
            "url": f"{OL_COVERS}/b/id/{covers[0]}-L.jpg", "preview": f"{OL_COVERS}/b/id/{covers[0]}-M.jpg",
            "label": " · ".join(x for x in (publisher, year, places.split(",")[0] if places else None) if x) or "Another edition",
            "uk": uk, "edition": {"isbn": isbn, "title": e.get("title"), "subtitle": e.get("subtitle"), "publisher": publisher,
                                  "year": year, "pages": e.get("number_of_pages"),
                                  # never turn a book you hold into an eBook just by borrowing a cover
                                  "format": f if (f := guess_format(e.get("physical_format"))) in FORMATS else None}}))
    for *_, o in sorted(others, key=lambda x: x[:3]):
        if o["url"] not in seen and len(out) < 40:
            seen.add(o["url"])
            out.append(o)
    return out


# ---------------------------------------------------------------- covers and spines
def edge_colours(img):
    """The spine colour: the cover's left edge usually wraps round onto the spine.
    The accent: the most striking colour elsewhere on the cover."""
    rgb = img.convert("RGB")
    w, h = rgb.size
    strip = rgb.crop((0, int(h * .04), max(2, int(w * .05)), int(h * .96)))
    spine = tuple(int(v) for v in ImageStat.Stat(strip).median)
    small = rgb.resize((60, 90))
    pal = small.quantize(colors=6, method=Image.Quantize.MEDIANCUT)
    counts = sorted(pal.getcolors(), reverse=True)
    palette = pal.getpalette()
    best, best_score = None, 0
    for n, idx in counts:
        r, g, b = palette[idx * 3: idx * 3 + 3]
        sat = max(r, g, b) - min(r, g, b)
        dist = sum(abs(a - c) for a, c in zip((r, g, b), spine))
        score = sat * (n / 5400) ** .3 * (dist > 80)
        if score > best_score:
            best, best_score = (r, g, b), score
    hexc = lambda c: "#%02x%02x%02x" % c
    return hexc(spine), hexc(best) if best else None


def save_image(data, folder, stem, max_h, portrait=False):
    img = Image.open(io.BytesIO(data))
    img = ImageOps.exif_transpose(img)
    if img.width < 60 or img.height < 60:
        raise ValueError("too small")      # a placeholder, not a real cover
    if portrait and img.width > img.height:
        img = img.rotate(90, expand=True)   # spines are tall; turn sideways photos upright
    img = img.convert("RGB")
    if img.height > max_h:
        img = img.resize((round(img.width * max_h / img.height), max_h), Image.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=86, optimize=True)
    name = f"{stem}-{hashlib.sha1(buf.getvalue()).hexdigest()[:8]}.jpg"
    (folder / name).write_bytes(buf.getvalue())
    return name, img


def remove_file(folder, name):
    if name:
        try:
            (folder / name).unlink()
        except FileNotFoundError:
            pass


def set_cover(c, book_id, data):
    """Store a cover image for a book and work out its spine colours."""
    old = c.execute("SELECT cover FROM books WHERE id=?", (book_id,)).fetchone()
    name, img = save_image(data, COVERS, str(book_id), 900)
    spine, accent = edge_colours(img)
    c.execute("UPDATE books SET cover=?, spine_colour=?, spine_accent=?, updated_at=? WHERE id=?",
              (name, spine, accent, now(), book_id))
    if old and old["cover"] != name:
        remove_file(COVERS, old["cover"])


def fetch_cover(c, book_id, urls):
    c.commit()      # don't hold the database locked while downloading
    for url in urls or []:
        try:
            set_cover(c, book_id, http_get(url, 15, accept="image/*"))
            return True
        except Exception:
            continue
    return False


# ---------------------------------------------------------------- background jobs (imports, covers)
JOB = {"running": False, "label": "", "done": 0, "total": 0, "found": 0, "finished_at": None}
_job_lock = threading.Lock()


def fill_in_details(book_ids):
    """Look up covers and missing details for books, one at a time, politely."""
    with _job_lock:
        if JOB["running"]:
            return False
        JOB.update(running=True, label="Finding covers and details", done=0, total=len(book_ids), found=0, finished_at=None)

    def work():
        try:
            for book_id in book_ids:
                with db() as c:
                    r = c.execute("SELECT * FROM books WHERE id=?", (book_id,)).fetchone()
                    if not r:
                        continue
                    info = None
                    if r["isbn"]:
                        info = lookup_isbn(r["isbn"])
                    else:
                        hits = search_books(f"{r['title']} {' '.join(json.loads(r['authors'])[:1])}")
                        hit = next((h for h in hits if h["title"].lower().startswith(r["title"].lower()[:20])), None)
                        if hit and hit.get("isbn"):
                            info = lookup_isbn(hit["isbn"]) or hit
                        elif hit:
                            info = hit
                    if info:
                        fill = {k: info.get(k) for k in ("pages", "publisher", "year", "description", "series",
                                                         "series_no", "height_mm", "thickness_mm", "format")
                                if info.get(k) and not r[k]}
                        if not r["isbn"] and info.get("isbn"):
                            fill["isbn"] = info["isbn"]
                        if fill:
                            c.execute(f"UPDATE books SET {', '.join(k + '=?' for k in fill)} WHERE id=?",
                                      (*fill.values(), book_id))
                        if not r["cover"] and fetch_cover(c, book_id, info.get("cover_urls")):
                            JOB["found"] += 1
                JOB["done"] += 1
                time.sleep(0.4)
        finally:
            JOB.update(running=False, finished_at=now())

    threading.Thread(target=work, daemon=True).start()
    return True


@app.get("/api/job")
def job_status():
    return JOB


# ---------------------------------------------------------------- books
def repair(c):
    """Keep every book findable: a book pointing at a bookcase or shelf that no longer exists
    goes back to 'To shelve', and anything with an unknown format counts as a paperback."""
    c.execute("""UPDATE books SET bookcase_id=NULL, shelf=NULL, shelf_pos=NULL WHERE bookcase_id IS NOT NULL AND (
                   status != 'owned' OR shelf IS NULL OR shelf < 0 OR
                   NOT EXISTS (SELECT 1 FROM bookcases k WHERE k.id = books.bookcase_id AND books.shelf < k.shelves))""")
    c.execute(f"UPDATE books SET format='paperback' WHERE format IS NULL OR format NOT IN ({','.join('?' * len(FORMATS))})",
              tuple(FORMATS))
    c.execute("UPDATE books SET status='owned' WHERE status NOT IN ('owned', 'wishlist')")


@app.get("/api/books")
def all_books():
    with db() as c:
        repair(c)
        return [book_out(r) for r in c.execute("SELECT * FROM books ORDER BY id")]


@app.get("/api/lookup")
def lookup(isbn: str):
    code = isbn13(isbn)
    if not code:
        raise HTTPException(400, "That doesn't look like an ISBN. It's the 13-digit number under the barcode, starting 978 or 979.")
    with db() as c:
        have = [book_out(r) for r in c.execute("SELECT * FROM books WHERE isbn=?", (code,))]
    LOOKUP_PROBLEMS.clear()
    info = lookup_isbn(code)
    if not info:
        lookup_failed("look that ISBN up")
    return {"isbn": code, "found": info, "have": have}


@app.get("/api/search")
def search(q: str):
    q = q.strip()
    if len(q) < 2:
        return []
    code = isbn13(q)
    LOOKUP_PROBLEMS.clear()
    if code:
        info = lookup_isbn(code)
        results = [info] if info else []
    else:
        results = search_books(q)
    if not results:
        lookup_failed("search")
    with db() as c:
        have = {r["isbn"]: r["status"] for r in c.execute("SELECT isbn, status FROM books WHERE isbn IS NOT NULL")}
        titles = {(r["title"].lower(), r["status"]) for r in c.execute("SELECT title, status FROM books")}
    for r in results:
        r["have"] = have.get(r.get("isbn")) or next((s for t, s in titles if t == (r["title"] or "").lower()), None)
    return results


EDITABLE = ("status", "title", "subtitle", "authors", "isbn", "publisher", "year", "pages", "format",
            "height_mm", "thickness_mm", "series", "series_no", "description", "read_status", "rating",
            "notes", "wish_priority", "wish_note", "loaned_to", "loaned_at")


def clean(field, value):
    if value in ("", None):
        return None
    if field == "authors":
        return json.dumps(split_authors(value))
    if field == "loaned_at":
        if not re.match(r"^\d{4}-\d{2}-\d{2}", str(value)):
            raise HTTPException(400, "The loan date should look like 2026-10-23")
        return str(value)[:10]
    if field == "isbn":
        return isbn13(value) or re.sub(r"[^0-9Xx]", "", str(value)) or None
    if field in ("pages", "rating", "wish_priority"):
        return int(float(value))
    if field in ("height_mm", "thickness_mm", "series_no"):
        return float(value)
    if field == "status" and value not in ("owned", "wishlist"):
        raise HTTPException(400, "status is owned or wishlist")
    if field == "format" and value not in FORMATS:
        raise HTTPException(400, "Unknown format")
    if field == "read_status" and value not in ("unread", "reading", "read"):
        raise HTTPException(400, "Unknown read status")
    return str(value).strip()


def end_of_shelf(c, case_id, shelf):
    r = c.execute("SELECT MAX(shelf_pos) FROM books WHERE bookcase_id=? AND shelf=?", (case_id, shelf)).fetchone()
    return (r[0] or 0) + 1


@app.post("/api/books")
def add_book(body: dict):
    """Add a book. With an ISBN (and lookup on), the details and cover are fetched;
    anything you sent overrides what's found."""
    found = {}
    code = isbn13(body.get("isbn"))
    if code and body.get("lookup", True):
        found = lookup_isbn(code) or {}
    data = {**found, **{k: v for k, v in body.items() if v not in (None, "", [])}}
    if code:
        data["isbn"] = code
    if not data.get("title"):
        raise HTTPException(404 if code else 400,
                            "Couldn't find that ISBN online. Add it by hand instead." if code else "A book needs a title")
    if not data.get("series"):
        t, s, n = split_title_series(data["title"])
        if s:
            data.update(title=t, series=s, series_no=n)
    data.setdefault("format", "paperback")
    if data.get("format") not in FORMATS:
        data["format"] = "paperback"
    fields = {k: clean(k, data.get(k)) for k in EDITABLE if data.get(k) not in (None, "")}
    fields.setdefault("status", "owned")
    fields.setdefault("authors", "[]")
    fields["added_at"] = fields["updated_at"] = now()
    with db() as c:
        case_id, shelf = body.get("bookcase_id"), body.get("shelf")
        if fields["status"] == "owned" and case_id is not None and shelf is not None:
            fields.update(bookcase_id=int(case_id), shelf=int(shelf), shelf_pos=end_of_shelf(c, case_id, shelf))
        cur = c.execute(f"INSERT INTO books ({', '.join(fields)}) VALUES ({', '.join('?' * len(fields))})",
                        tuple(fields.values()))
        book_id = cur.lastrowid
        urls = (found.get("cover_urls") or []) + (body.get("cover_urls") or []) + \
            ([body["cover_preview"]] if body.get("cover_preview") else [])
        fetch_cover(c, book_id, urls)
        return book_out(get_book(c, book_id))


@app.patch("/api/books/{book_id}")
def edit_book(book_id: int, body: dict):
    with db() as c:
        get_book(c, book_id)
        fields = {k: clean(k, v) for k, v in body.items() if k in EDITABLE}
        if fields.get("status") == "wishlist":
            fields.update(bookcase_id=None, shelf=None, shelf_pos=None, loaned_to=None, loaned_at=None)
        if fields:
            fields["updated_at"] = now()
            c.execute(f"UPDATE books SET {', '.join(k + '=?' for k in fields)} WHERE id=?", (*fields.values(), book_id))
        if "place" in body:          # {"bookcase_id": 1, "shelf": 0} or null to take it off the shelves
            p = body["place"]
            if p and p.get("bookcase_id") is not None:
                c.execute("UPDATE books SET bookcase_id=?, shelf=?, shelf_pos=? WHERE id=?",
                          (int(p["bookcase_id"]), int(p["shelf"]), end_of_shelf(c, p["bookcase_id"], p["shelf"]), book_id))
            else:
                c.execute("UPDATE books SET bookcase_id=NULL, shelf=NULL, shelf_pos=NULL WHERE id=?", (book_id,))
        return book_out(get_book(c, book_id))


@app.post("/api/books/{book_id}/got-it")
def got_it(book_id: int):
    """A wishlist book has arrived: it joins your library, waiting to be shelved."""
    with db() as c:
        get_book(c, book_id)
        c.execute("UPDATE books SET status='owned', added_at=?, updated_at=? WHERE id=?", (now(), now(), book_id))
        return book_out(get_book(c, book_id))


@app.delete("/api/books/{book_id}")
def delete_book(book_id: int):
    with db() as c:
        r = get_book(c, book_id)
        c.execute("DELETE FROM books WHERE id=?", (book_id,))
    remove_file(COVERS, r["cover"])
    remove_file(SPINES, r["spine_photo"])
    return {"ok": True}


@app.get("/api/books/{book_id}/covers")
def book_covers(book_id: int):
    with db() as c:
        r = get_book(c, book_id)
    LOOKUP_PROBLEMS.clear()
    found = edition_choices(r)
    if not found:
        lookup_failed("find other editions")
    return found


@app.post("/api/books/{book_id}/refresh")
def refresh_book(book_id: int):
    """Look the ISBN up again: fills any blanks and tries for a cover if there isn't one."""
    with db() as c:
        r = get_book(c, book_id)
        if not r["isbn"]:
            raise HTTPException(400, "This book has no ISBN to look up")
        info = lookup_isbn(r["isbn"])
        if not info:
            raise HTTPException(404, "Nothing found online for this ISBN")
        fill = {k: info.get(k) for k in ("pages", "publisher", "year", "description", "series", "series_no",
                                         "height_mm", "thickness_mm", "subtitle") if info.get(k) and not r[k]}
        if info.get("authors") and r["authors"] in (None, "[]"):
            fill["authors"] = json.dumps(info["authors"])
        if fill:
            c.execute(f"UPDATE books SET {', '.join(k + '=?' for k in fill)} WHERE id=?", (*fill.values(), book_id))
        got_cover = fetch_cover(c, book_id, info.get("cover_urls"))
        return {"book": book_out(get_book(c, book_id)), "filled": list(fill), "cover": got_cover}


@app.post("/api/books/{book_id}/cover")
async def upload_cover(book_id: int, file: UploadFile = File(None), url: str = Form(None)):
    data = await file.read() if file else None
    with db() as c:
        get_book(c, book_id)
        try:
            if data:
                set_cover(c, book_id, data)
            elif url:
                set_cover(c, book_id, http_get(url, 15, accept="image/*"))
            else:
                raise HTTPException(400, "Send a photo")
        except (OSError, ValueError, urllib.error.URLError):
            raise HTTPException(400, "Couldn't use that picture")
        return book_out(get_book(c, book_id))


@app.post("/api/books/{book_id}/spine")
async def upload_spine(book_id: int, file: UploadFile = File(...)):
    data = await file.read()
    with db() as c:
        r = get_book(c, book_id)
        try:
            name, _ = save_image(data, SPINES, str(book_id), 1400, portrait=True)
        except (OSError, ValueError):
            raise HTTPException(400, "Couldn't use that picture")
        c.execute("UPDATE books SET spine_photo=?, updated_at=? WHERE id=?", (name, now(), book_id))
        if r["spine_photo"] != name:
            remove_file(SPINES, r["spine_photo"])
        return book_out(get_book(c, book_id))


@app.post("/api/books/{book_id}/spine/rotate")
def rotate_spine(book_id: int, degrees: int = 180):
    with db() as c:
        r = get_book(c, book_id)
        if not r["spine_photo"]:
            raise HTTPException(400, "No spine photo")
        img = Image.open(SPINES / r["spine_photo"]).rotate(-degrees, expand=True)
        buf = io.BytesIO()
        img.save(buf, "JPEG", quality=88)
        name, _ = save_image(buf.getvalue(), SPINES, str(book_id), 1400)
        c.execute("UPDATE books SET spine_photo=? WHERE id=?", (name, book_id))
        if r["spine_photo"] != name:
            remove_file(SPINES, r["spine_photo"])
        return book_out(get_book(c, book_id))


@app.delete("/api/books/{book_id}/spine")
def remove_spine(book_id: int):
    with db() as c:
        r = get_book(c, book_id)
        c.execute("UPDATE books SET spine_photo=NULL WHERE id=?", (book_id,))
        remove_file(SPINES, r["spine_photo"])
        return book_out(get_book(c, book_id))


# ---------------------------------------------------------------- bookcases
CASE_FIELDS = ("name", "shelves", "width_cm", "shelf_height_cm", "wood")
WOODS = ("oak", "walnut", "pine", "white", "black", "grey")


@app.get("/api/bookcases")
def bookcases():
    with db() as c:
        return [dict(r) for r in c.execute("SELECT * FROM bookcases ORDER BY pos, id")]


def case_values(body):
    out = {}
    for k in CASE_FIELDS:
        if k in body and body[k] not in (None, ""):
            out[k] = str(body[k]).strip() if k in ("name", "wood") else float(body[k])
    if "shelves" in out:
        out["shelves"] = max(1, min(int(out["shelves"]), 20))
    if "wood" in out and out["wood"] not in WOODS:
        out["wood"] = "oak"
    return out


@app.post("/api/bookcases")
def add_bookcase(body: dict):
    v = case_values(body)
    if not v.get("name"):
        raise HTTPException(400, "Give the bookcase a name")
    with db() as c:
        v["pos"] = (c.execute("SELECT MAX(pos) FROM bookcases").fetchone()[0] or 0) + 1
        cur = c.execute(f"INSERT INTO bookcases ({', '.join(v)}) VALUES ({', '.join('?' * len(v))})", tuple(v.values()))
        return dict(c.execute("SELECT * FROM bookcases WHERE id=?", (cur.lastrowid,)).fetchone())


@app.patch("/api/bookcases/{case_id}")
def edit_bookcase(case_id: int, body: dict):
    v = case_values(body)
    with db() as c:
        if v:
            c.execute(f"UPDATE bookcases SET {', '.join(k + '=?' for k in v)} WHERE id=?", (*v.values(), case_id))
        if "shelves" in v:     # fewer shelves: books on the removed ones go back to "to shelve"
            c.execute("UPDATE books SET bookcase_id=NULL, shelf=NULL, shelf_pos=NULL WHERE bookcase_id=? AND shelf>=?",
                      (case_id, v["shelves"]))
        r = c.execute("SELECT * FROM bookcases WHERE id=?", (case_id,)).fetchone()
        if not r:
            raise HTTPException(404, "No such bookcase")
        return dict(r)


@app.delete("/api/bookcases/{case_id}")
def delete_bookcase(case_id: int):
    with db() as c:
        c.execute("UPDATE books SET bookcase_id=NULL, shelf=NULL, shelf_pos=NULL WHERE bookcase_id=?", (case_id,))
        c.execute("DELETE FROM bookcases WHERE id=?", (case_id,))
    return {"ok": True}


@app.post("/api/arrange")
def arrange(body: dict):
    """Save the order of books on shelves after dragging. body: {"lists": [{"bookcase_id": 1,
    "shelf": 0, "ids": [5, 3, 9]}, {"bookcase_id": null, "ids": [...]}]}"""
    with db() as c:
        for lst in body.get("lists") or []:
            case_id, shelf = lst.get("bookcase_id"), lst.get("shelf")
            for i, book_id in enumerate(lst.get("ids") or []):
                if case_id is None:
                    c.execute("UPDATE books SET bookcase_id=NULL, shelf=NULL, shelf_pos=NULL WHERE id=?", (book_id,))
                else:
                    c.execute("UPDATE books SET bookcase_id=?, shelf=?, shelf_pos=?, status='owned' WHERE id=?",
                              (int(case_id), int(shelf), i + 1, int(book_id)))
    return {"ok": True}


def hue_key(b):
    import colorsys
    col = b["spine_colour"] or "#888888"
    r, g, bl = (int(col[i:i + 2], 16) / 255 for i in (1, 3, 5))
    h, l, s = colorsys.rgb_to_hls(r, g, bl)
    return (0 if s > .18 and .12 < l < .9 else 1, round(h * 12) % 12 if s > .18 else l, l)


ORDERS = {
    "author": lambda b: (author_sort((json.loads(b["authors"]) or [""])[0]), (b["series"] or "").lower(),
                         b["series_no"] or 0, b["year"] or "", b["title"].lower()),
    "title": lambda b: re.sub(r"^(the|a|an)\s+", "", b["title"].lower()),
    "series": lambda b: ((b["series"] or "~").lower(), b["series_no"] or 0, b["title"].lower()),
    "colour": hue_key,
    "height": lambda b: (-dims(b)[0], b["title"].lower()),
}


@app.post("/api/bookcases/{case_id}/fill")
def fill_bookcase(case_id: int, body: dict):
    """Arrange books automatically, shelf by shelf, until each shelf is full.
    source "tray": add books waiting to be shelved after what's already there.
    source "case": re-sort everything already in this bookcase."""
    order = ORDERS.get(body.get("order"), ORDERS["author"])
    with db() as c:
        case = c.execute("SELECT * FROM bookcases WHERE id=?", (case_id,)).fetchone()
        if not case:
            raise HTTPException(404, "No such bookcase")
        width = case["width_cm"] * 10
        used = [0.0] * case["shelves"]
        count = [0] * case["shelves"]
        if body.get("source") == "case":
            books = c.execute("SELECT * FROM books WHERE bookcase_id=?", (case_id,)).fetchall()
            c.execute("UPDATE books SET bookcase_id=NULL, shelf=NULL, shelf_pos=NULL WHERE bookcase_id=?", (case_id,))
        else:
            books = c.execute(f"SELECT * FROM books WHERE status='owned' AND bookcase_id IS NULL AND "
                              "1=1").fetchall()
            for r in c.execute("SELECT * FROM books WHERE bookcase_id=?", (case_id,)):
                if r["shelf"] is not None and r["shelf"] < case["shelves"]:
                    used[r["shelf"]] += dims(r)[1]
                    count[r["shelf"]] = max(count[r["shelf"]], int(r["shelf_pos"] or 0))
        placed, shelf = 0, 0
        for b in sorted(books, key=order):
            t = dims(b)[1]
            while shelf < case["shelves"] and used[shelf] + t > width and used[shelf] > 0:
                shelf += 1
            if shelf >= case["shelves"]:
                break
            used[shelf] += t
            count[shelf] += 1
            c.execute("UPDATE books SET bookcase_id=?, shelf=?, shelf_pos=? WHERE id=?", (case_id, shelf, count[shelf], b["id"]))
            placed += 1
        return {"placed": placed, "left": len(books) - placed}


# ---------------------------------------------------------------- series
@app.get("/api/series-info")
def series_info():
    with db() as c:
        return {r["name"]: r["total"] for r in c.execute("SELECT * FROM series_info")}


@app.put("/api/series-info")
def set_series_info(body: dict):
    name = (body.get("name") or "").strip()
    if not name:
        raise HTTPException(400, "Which series?")
    total = body.get("total")
    with db() as c:
        if total in (None, "", 0):
            c.execute("DELETE FROM series_info WHERE name=?", (name,))
        else:
            c.execute("INSERT INTO series_info (name, total) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET total=excluded.total",
                      (name, int(total)))
    return series_info()


@app.post("/api/series/rename")
def rename_series(body: dict):
    old, new = (body.get("old") or "").strip(), (body.get("new") or "").strip()
    if not old or not new:
        raise HTTPException(400, "Need the old and new names")
    with db() as c:
        c.execute("UPDATE books SET series=? WHERE series=? COLLATE NOCASE", (new, old))
        c.execute("UPDATE series_info SET name=? WHERE name=?", (new, old))
    return {"ok": True}


# ---------------------------------------------------------------- import / export / backup
EXPORT_COLS = ["title", "subtitle", "authors", "isbn", "series", "series_no", "format", "pages", "year", "publisher",
               "status", "read_status", "rating", "bookcase", "shelf", "notes", "wish_priority", "wish_note", "loaned_to", "loaned_at", "added_at"]


@app.get("/api/export.csv")
def export_csv():
    with db() as c:
        cases = {r["id"]: r["name"] for r in c.execute("SELECT id, name FROM bookcases")}
        rows = c.execute("SELECT * FROM books ORDER BY status, title").fetchall()
    out = io.StringIO()
    w = csv.writer(out)
    w.writerow(EXPORT_COLS)
    for r in rows:
        b = dict(r)
        b["authors"] = " & ".join(json.loads(b["authors"] or "[]"))
        b["bookcase"] = cases.get(b["bookcase_id"], "")
        b["shelf"] = (b["shelf"] + 1) if b["shelf"] is not None else ""
        w.writerow([b.get(k) if b.get(k) is not None else "" for k in EXPORT_COLS])
    return Response(out.getvalue(), media_type="text/csv",
                    headers={"Content-Disposition": f'attachment; filename="books-{datetime.now():%Y-%m-%d}.csv"'})


def goodreads_row(row, to_read):
    title, series, no = split_title_series(row.get("Title", "").strip())
    authors = [row.get("Author", "")] + [a for a in (row.get("Additional Authors") or "").split(",")]
    shelf = (row.get("Exclusive Shelf") or "").strip()
    owned = (row.get("Owned Copies") or "0").strip() not in ("", "0")
    status, read = "owned", {"read": "read", "currently-reading": "reading"}.get(shelf, "unread")
    if shelf == "to-read" and not owned:
        if to_read == "skip":
            return None
        status = "wishlist" if to_read == "wishlist" else "owned"
    isbn = isbn13(row.get("ISBN13", "")) or isbn13(row.get("ISBN", ""))
    rating = int(row.get("My Rating") or 0) or None
    return {"title": title, "series": series, "series_no": no, "authors": [a.strip() for a in authors if a.strip()],
            "isbn": isbn, "publisher": row.get("Publisher"), "pages": row.get("Number of Pages"),
            "year": row.get("Original Publication Year") or row.get("Year Published"),
            "format": guess_format(row.get("Binding")) or "paperback", "status": status, "read_status": read,
            "rating": rating, "notes": row.get("Private Notes")}


@app.post("/api/import")
async def import_csv(file: UploadFile = File(...), to_read: str = Form("wishlist")):
    """Goodreads export (My Books > Import and export > Export library) or this app's own CSV."""
    text = (await file.read()).decode("utf-8-sig", errors="replace")
    rows = list(csv.DictReader(io.StringIO(text)))
    if not rows:
        raise HTTPException(400, "That file has no rows")
    goodreads = "Exclusive Shelf" in rows[0]
    if not goodreads and "title" not in rows[0]:
        raise HTTPException(400, "That doesn't look like a Goodreads export or a Book Tracker CSV")
    added, skipped, new_ids = 0, 0, []
    with db() as c:
        cases = {r["name"].lower(): r["id"] for r in c.execute("SELECT id, name FROM bookcases")}
        have_isbn = {(r["isbn"], r["status"]) for r in c.execute("SELECT isbn, status FROM books WHERE isbn IS NOT NULL")}
        have_title = {(r["title"].lower(), r["status"]) for r in c.execute("SELECT title, status FROM books")}
        for row in rows:
            b = goodreads_row(row, to_read) if goodreads else dict(row)
            if b and b.get("format") in DIGITAL:      # Kindle and audio editions aren't logged
                skipped += 1
                continue
            if not b or not (b.get("title") or "").strip():
                skipped += 1
                continue
            if b.get("format") not in FORMATS:
                b["format"] = "paperback"
            b.setdefault("status", "owned")
            if b["status"] not in ("owned", "wishlist"):
                b["status"] = "owned"
            isbn = isbn13(b.get("isbn"))
            if (isbn and (isbn, b["status"]) in have_isbn) or (b["title"].strip().lower(), b["status"]) in have_title:
                skipped += 1
                continue
            try:
                fields = {k: clean(k, b.get(k)) for k in EDITABLE if b.get(k) not in (None, "", [])}
            except (ValueError, HTTPException):
                skipped += 1
                continue
            fields.setdefault("authors", "[]")
            fields["added_at"] = b.get("added_at") or now()
            fields["updated_at"] = now()
            case_id = cases.get((b.get("bookcase") or "").lower())
            if case_id and str(b.get("shelf") or "").isdigit() and fields["status"] == "owned":
                fields.update(bookcase_id=case_id, shelf=int(b["shelf"]) - 1,
                              shelf_pos=end_of_shelf(c, case_id, int(b["shelf"]) - 1))
            cur = c.execute(f"INSERT INTO books ({', '.join(fields)}) VALUES ({', '.join('?' * len(fields))})",
                            tuple(fields.values()))
            new_ids.append(cur.lastrowid)
            have_isbn.add((isbn, b["status"]))
            have_title.add((b["title"].strip().lower(), b["status"]))
            added += 1
    started = fill_in_details(new_ids) if new_ids else False
    return {"added": added, "skipped": skipped, "fetching": started}


@app.post("/api/fetch-missing")
def fetch_missing():
    with db() as c:
        ids = [r[0] for r in c.execute("SELECT id FROM books WHERE cover IS NULL")]
    if not ids:
        return {"started": False, "count": 0}
    if not fill_in_details(ids):
        raise HTTPException(409, "Already busy finding covers")
    return {"started": True, "count": len(ids)}


@app.get("/api/backup")
def backup(background: BackgroundTasks):
    """Everything in one zip: the database plus all covers and spine photos."""
    tmp = Path(tempfile.mkdtemp())
    snap = tmp / "books.db"
    with db() as c:
        dst = sqlite3.connect(snap)
        c.backup(dst)
        dst.close()
    out = tmp / f"booktracker-backup-{datetime.now():%Y-%m-%d}.zip"
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        z.write(snap, "books.db")
        for folder in (COVERS, SPINES):
            for f in folder.glob("*.jpg"):
                z.write(f, f"{folder.name}/{f.name}")
    background.add_task(shutil.rmtree, tmp, True)
    return FileResponse(out, filename=out.name, media_type="application/zip")


# ---------------------------------------------------------------- the page
@app.get("/covers/{name}")
def cover_file(name: str):
    f = COVERS / Path(name).name
    if not f.exists():
        raise HTTPException(404)
    return FileResponse(f, headers={"Cache-Control": "public, max-age=31536000, immutable"})


@app.get("/spines/{name}")
def spine_file(name: str):
    f = SPINES / Path(name).name
    if not f.exists():
        raise HTTPException(404)
    return FileResponse(f, headers={"Cache-Control": "public, max-age=31536000, immutable"})


STATIC = HERE / "static"
app.mount("/static", StaticFiles(directory=STATIC), name="static")


@app.get("/manifest.json")
def manifest():
    return FileResponse(STATIC / "manifest.json", media_type="application/manifest+json")


@app.get("/sw.js")
def service_worker():
    return FileResponse(STATIC / "sw.js", media_type="text/javascript")


@app.get("/")
def index():
    return FileResponse(STATIC / "index.html", headers={"Cache-Control": "no-cache"})
