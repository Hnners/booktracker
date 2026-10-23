# Book Tracker

A self-hosted home library: your books with their covers and spines, your bookcases drawn shelf by shelf,
authors, series (with the gaps you're missing) and a wishlist. Built like Card Tracker: FastAPI + SQLite,
plain JavaScript, installable on a phone. Runs as `booktracker.service` in the `booktracker` container at
`/opt/booktracker`.

## Setting it up (once)

1. In Proxmox, make a new LXC container from the Debian 12 template (1 CPU, 512 MB RAM and 8 GB disk is plenty)
   and call it `booktracker`.
2. In its console, as root:

   ```
   apt update && apt install -y git
   git clone https://github.com/Hnners/booktracker /opt/booktracker
   /opt/booktracker/install.sh
   ```

   It prints the address to open, e.g. `http://192.168.1.50:8000`.
3. To reach it from outside and to use the **barcode scanner** (phones only allow the camera on `https://`),
   add a public hostname to your existing Cloudflare Tunnel, e.g. `books.henners.org.uk` → `http://<container-ip>:8000`,
   and add it to a Cloudflare Access application with your email one-time PIN policy, as you did for Card Tracker.
   Include your wife's email in the policy.
4. Open `https://books.henners.org.uk` on each phone and use "Add to Home Screen" / "Install app".

## Updating

```
/opt/booktracker/update.sh
```

Pulls the latest code from GitHub and restarts. Your books (`books.db`), covers and spine photos are never in
the repository and aren't touched.

## How it works

- **Adding books**: scan barcodes with the phone camera (with "Keep scanning" on, each book is added in the
  order you scan, straight onto the shelf you chose, so you can scan a shelf left to right), type an ISBN, or
  search by title/author. Scanning a book you already have tells you where it is, handy in a shop.
- **Details and covers** come from [Google Books](https://books.google.com) and [Open Library](https://openlibrary.org),
  both free with no account. Open Library also knows most series. Covers are saved on the server.
- **Spines**: there's no public source of spine pictures, so each spine is drawn from the cover's edge colour,
  with the title and author, its thickness from the page count and height from the format. Take a photo of
  the real spine on any book to use that instead.
- **Bookcases** are drawn to scale from the shelf width you measure, so you can see when a shelf is full.
  Drag spines between shelves (on a phone, hold a moment first), or use Arrange to fill shelves by author,
  series, title, colour or height.
- **Authors** and **Series** tabs group everything automatically. Set how many books a series has to see the
  gaps; tap a gap to find it and put it on the wishlist.
- **Import** a Goodreads export (series in titles like "Mort (Discworld, #4)" are picked up). Export to CSV, or
  download a full backup zip (database and pictures) from More.

Optional: set `GOOGLE_BOOKS_KEY` in the service file if you ever hit Google's daily lookup limit.

## Files

- `app.py`: the web app and API
- `static/`: the page (`index.html`, `app.js`, `style.css`), icons, and `vendor/` (SortableJS for dragging,
  ZXing for barcode scanning on iPhones)
- `booktracker.service`, `install.sh`, `update.sh`: running it on the server
