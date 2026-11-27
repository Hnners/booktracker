# L.I.B.R.A.R.Y. – Lovingly Indexed Bookcases, Reads, Authors, Rows & Yarns

A Home Assistant add-on for our home library: every book with its cover and spine, the bookcases
drawn shelf by shelf, authors, series with the gaps you're missing, a wishlist and books on loan.
It has its own sidebar panel, like M.A.S.H. and C.R.A.P.

![L.I.B.R.A.R.Y.](logo.png)

## Install

1. In Home Assistant, go to **Settings → Add-ons → Add-on store**, open the **⋮** menu and choose
   **Repositories**.
2. Add `https://github.com/Hnners/booktracker` and close the dialog.
3. Find **L.I.B.R.A.R.Y.** in the store, install it, turn on **Show in sidebar**, and start it.

Anyone with a Home Assistant login can use it, from a browser or the HA companion app. Books,
covers and spine photos live in the add-on's `/data`, so they're included in HA backups. You can also
download a backup zip and a CSV from **More**.

## How it works

- **Adding books**: scan barcodes with the phone camera. With "Keep scanning" on, each book is added
  in the order you scan, straight onto the shelf you chose, so you can scan a shelf left to right.
  You can also type an ISBN or search by title/author. Scanning a book you already have tells you where it is.
- **Live scanning needs https.** Phones only allow the camera on `https://` addresses, so it works
  when Home Assistant is opened over https (Nabu Casa, a Cloudflare tunnel, your own domain). On a
  plain `http://` address, use **Photo of a barcode** in the scanner instead: take a photo and the
  barcode is read from it.
- **Details and covers** come from Google Books and Open Library, both free with no account.
  Open Library and Wikidata also know most series.
- **Spines** are drawn from the cover's edge colour, with the title and author. Their thickness
  comes from the page count and their height from the format. You can photograph the real spine instead.
- **Bookcases** are drawn to scale from the shelf width you measure. Drag spines between shelves (on a
  phone, hold first), stack books flat, or use **Arrange** to fill shelves by author, series, title,
  colour or height.
- **Authors** and **Series** are grouped automatically. If you set how many books a series has, it
  shows the gaps, and you can tap a gap to find that book and add it to the wishlist.
- **Import** a Goodreads export (series in titles like "Mort (Discworld, #4)" are picked up).
- **Home Assistant sensor**: `sensor.library_books` (books owned), with the wishlist, read, reading,
  on loan and bookcase counts as attributes.

## Options

| Option | Default | What it does |
| --- | --- | --- |
| `google_books_key` | empty | Optional Google Books API key, if you ever hit Google's daily lookup limit |
| `publish_sensor` | true | Publish `sensor.library_books` to HA |

## Development

```bash
cd library
pip install -r requirements.txt
LIBRARY_DATA=./data python -m uvicorn app.main:app --reload --port 8099
```

Then open <http://localhost:8099>. Every URL in the page is relative (no leading `/`), because
Home Assistant serves add-on panels under `/api/hassio_ingress/<token>/`.

### Layout

```
repository.yaml       makes this repo an add-on repository
library/
  config.yaml         add-on manifest
  Dockerfile
  app/main.py         FastAPI app and API (SQLite in /data/books.db)
  app/static/         front end: plain HTML/CSS/JS, no build step; vendor/ has SortableJS and ZXing
```

This repo used to be "Book Tracker / Gabbie's Library", which ran as a service in its own Proxmox
LXC container. That set-up has been replaced by the add-on.
