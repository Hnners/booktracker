#!/bin/bash
# Book Tracker: first-time setup in a fresh Debian/Ubuntu container. Run as root:
#   apt update && apt install -y git
#   git clone https://github.com/Hnners/booktracker /opt/booktracker
#   /opt/booktracker/install.sh
set -e
cd /opt/booktracker
apt-get install -y python3-venv python3-pip
id henry >/dev/null 2>&1 || useradd --system --home /opt/booktracker --shell /usr/sbin/nologin henry
python3 -m venv venv
venv/bin/pip install -q --upgrade pip
venv/bin/pip install -q -r requirements.txt
chmod +x update.sh
cp booktracker.service /etc/systemd/system/
chown -R henry:henry /opt/booktracker
systemctl daemon-reload
systemctl enable --now booktracker
sleep 2
systemctl --no-pager --lines=5 status booktracker || true
echo
echo "Book Tracker is running: http://$(hostname -I | awk '{print $1}'):8000"
