#!/bin/bash
# Book Tracker: fetch the latest version from GitHub and restart.
# Run inside the booktracker container:  /opt/booktracker/update.sh
# Only code comes from GitHub. Your books, covers and spine photos are never in the
# repository, so an update can't touch them.
set -e
cd /opt/booktracker
before=$(git rev-parse --short HEAD)
git pull --ff-only origin main
after=$(git rev-parse --short HEAD)
if [ "$before" = "$after" ]; then
  echo "Already up to date ($after)."
  exit 0
fi
echo "Updated $before -> $after:"
git log --oneline "$before..$after"
venv/bin/pip install -q -r requirements.txt
cp -u booktracker.service /etc/systemd/system/ && systemctl daemon-reload || true
chown -R henry:henry /opt/booktracker
systemctl restart booktracker
echo "Book Tracker restarted."
