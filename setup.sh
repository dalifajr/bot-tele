#!/usr/bin/env bash
set -e

echo "[1/7] Update package index"
sudo apt-get update -y

echo "[2/7] Install system dependencies"
sudo apt-get install -y curl ca-certificates nano

echo "[3/7] Install Node.js 20"
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

echo "[4/7] Install project dependencies"
npm install

echo "[5/7] Prepare environment file"
if [ ! -f .env ]; then
  cp .env.example .env
  echo "File .env dibuat dari .env.example, silakan isi token dan admin ID"
fi

echo "[6/7] Validate/migrate data"
node src/scripts/checkDataFiles.js
node src/scripts/migrateTextAccounts.js || true

echo "[7/7] Prepare server panel"
chmod +x install/bot-panel.sh

echo "Done"
echo "Jalankan bot dengan: npm start"
echo "Jalankan panel server: ./install/bot-panel.sh"
