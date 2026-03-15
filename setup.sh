#!/usr/bin/env bash
set -e

echo "[1/6] Update package index"
sudo apt-get update -y

echo "[2/6] Install Node.js 20"
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

echo "[3/6] Install project dependencies"
npm install

echo "[4/6] Prepare environment file"
if [ ! -f .env ]; then
  cp .env.example .env
  echo "File .env dibuat dari .env.example, silakan isi token dan admin ID"
fi

echo "[5/6] Validate/migrate data"
node src/scripts/checkDataFiles.js
node src/scripts/migrateTextAccounts.js || true

echo "[6/6] Done"
echo "Jalankan bot dengan: npm start"
