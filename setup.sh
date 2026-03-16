#!/usr/bin/env bash
set -euo pipefail

SCRIPT_PATH="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${PROJECT_DIR}/.env"
SERVICE_NAME="bot-tele.service"
BACKUP_DIR="${PROJECT_DIR}/backup"

ensure_linux_systemd() {
  if ! command -v systemctl >/dev/null 2>&1; then
    echo "Panel ini ditujukan untuk server Linux dengan systemd."
    exit 1
  fi
}

ensure_env_file() {
  if [ ! -f "${ENV_FILE}" ]; then
    cp "${PROJECT_DIR}/.env.example" "${ENV_FILE}"
    echo ".env dibuat dari .env.example"
  fi
}

get_env_value() {
  local key="$1"
  if [ -f "${ENV_FILE}" ]; then
    local line
    line="$(grep -E "^${key}=" "${ENV_FILE}" | tail -n 1 || true)"
    echo "${line#*=}"
  fi
}

set_env_value() {
  local key="$1"
  local value="$2"
  ensure_env_file

  if grep -qE "^${key}=" "${ENV_FILE}"; then
    sed -i "s|^${key}=.*|${key}=${value}|" "${ENV_FILE}"
  else
    echo "${key}=${value}" >> "${ENV_FILE}"
  fi
}

pause_screen() {
  echo
  read -rp "Tekan Enter untuk kembali ke menu..." _
}

show_current_config() {
  ensure_env_file
  echo "=== Konfigurasi aktif (.env) ==="
  echo "TELEGRAM_BOT_TOKEN=$(get_env_value TELEGRAM_BOT_TOKEN | sed 's/./*/g')"
  echo "ADMIN_TELEGRAM_IDS=$(get_env_value ADMIN_TELEGRAM_IDS)"
  echo "WHATSAPP_ENABLED=$(get_env_value WHATSAPP_ENABLED)"
  echo "ADMIN_WHATSAPP_NUMBERS=$(get_env_value ADMIN_WHATSAPP_NUMBERS)"
  echo "WHATSAPP_PUPPETEER_EXECUTABLE_PATH=$(get_env_value WHATSAPP_PUPPETEER_EXECUTABLE_PATH)"
  echo "STORE_NAME=$(get_env_value STORE_NAME)"
  echo "PRODUCT_NAME=$(get_env_value PRODUCT_NAME)"
  echo "PRODUCT_PRICE_IDR=$(get_env_value PRODUCT_PRICE_IDR)"
  echo "APP_PORT=$(get_env_value APP_PORT)"
  echo "PUBLIC_BASE_URL=$(get_env_value PUBLIC_BASE_URL)"
  echo "QRIS_PROVIDER=$(get_env_value QRIS_PROVIDER)"
  echo "PAYMENT_WEBHOOK_SECRET=$(get_env_value PAYMENT_WEBHOOK_SECRET | sed 's/./*/g')"
}

configure_basic_env() {
  ensure_env_file
  echo "=== Setup konfigurasi dasar ==="

  local bot_token
  read -rp "TELEGRAM_BOT_TOKEN: " bot_token
  if [ -n "${bot_token}" ]; then
    set_env_value "TELEGRAM_BOT_TOKEN" "${bot_token}"
  fi

  local admin_ids
  read -rp "ADMIN_TELEGRAM_IDS (pisahkan koma): " admin_ids
  if [ -n "${admin_ids}" ]; then
    set_env_value "ADMIN_TELEGRAM_IDS" "${admin_ids}"
  fi

  local app_port
  read -rp "APP_PORT [3000]: " app_port
  if [ -n "${app_port}" ]; then
    set_env_value "APP_PORT" "${app_port}"
  fi

  local provider
  read -rp "QRIS_PROVIDER [SIMULATED]: " provider
  if [ -n "${provider}" ]; then
    set_env_value "QRIS_PROVIDER" "${provider}"
  fi

  local webhook_secret
  read -rp "PAYMENT_WEBHOOK_SECRET: " webhook_secret
  if [ -n "${webhook_secret}" ]; then
    set_env_value "PAYMENT_WEBHOOK_SECRET" "${webhook_secret}"
  fi

  echo "Konfigurasi dasar tersimpan ke .env"
}

edit_env_file() {
  ensure_env_file
  ${EDITOR:-nano} "${ENV_FILE}"
}

install_or_update_dependencies() {
  echo "Install dependency npm..."
  npm install
  echo "Dependency berhasil diinstall."
}

run_data_check() {
  echo "Jalankan validasi data..."
  node src/scripts/checkDataFiles.js
  echo "Jalankan migrasi format akun..."
  node src/scripts/migrateTextAccounts.js || true
}

install_service_file() {
  local run_user
  run_user="${SUDO_USER:-$USER}"

  sudo tee /etc/systemd/system/${SERVICE_NAME} >/dev/null <<EOF
[Unit]
Description=BOT TELE Digital Store
After=network.target

[Service]
Type=simple
WorkingDirectory=${PROJECT_DIR}
ExecStart=/usr/bin/npm start
Restart=always
RestartSec=5
User=${run_user}
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

  sudo systemctl daemon-reload
  sudo systemctl enable ${SERVICE_NAME}
  echo "Service ${SERVICE_NAME} sudah dibuat dan di-enable."
}

service_start() {
  sudo systemctl start ${SERVICE_NAME}
  sudo systemctl status ${SERVICE_NAME} --no-pager
}

service_stop() {
  sudo systemctl stop ${SERVICE_NAME}
  sudo systemctl status ${SERVICE_NAME} --no-pager || true
}

service_restart() {
  sudo systemctl restart ${SERVICE_NAME}
  sudo systemctl status ${SERVICE_NAME} --no-pager
}

service_status() {
  sudo systemctl status ${SERVICE_NAME} --no-pager
}

service_logs() {
  sudo journalctl -u ${SERVICE_NAME} -n 100 --no-pager
}

service_logs_follow() {
  echo "Tekan Ctrl+C untuk berhenti melihat log realtime."
  sudo journalctl -u ${SERVICE_NAME} -f
}

health_check() {
  local app_port
  app_port="$(get_env_value APP_PORT)"
  if [ -z "${app_port}" ]; then
    app_port="3000"
  fi

  local url="http://127.0.0.1:${app_port}/health"
  echo "Cek health endpoint: ${url}"
  curl -fsS "${url}" && echo
}

backup_data() {
  mkdir -p "${BACKUP_DIR}"
  local ts
  ts="$(date +%Y%m%d_%H%M%S)"
  local archive="${BACKUP_DIR}/bot-tele-backup-${ts}.tar.gz"

  tar -czf "${archive}" \
    list_akun_ready.json \
    awaiting_benefits.json \
    terjual.json \
    data \
    .env

  echo "Backup dibuat: ${archive}"
}

install_whatsapp_system_dependencies() {
  echo "Install dependency sistem untuk WhatsApp (Chromium/Puppeteer)..."
  sudo apt-get update -y
  sudo apt-get install -y \
    ca-certificates fonts-liberation libasound2 libatk-bridge2.0-0 libatk1.0-0 \
    libcups2 libdbus-1-3 libdrm2 libgbm1 libglib2.0-0 libgtk-3-0 libnspr4 \
    libnss3 libx11-6 libx11-xcb1 libxcb1 libxcomposite1 libxdamage1 libxext6 \
    libxfixes3 libxrandr2 xdg-utils

  # Install Chromium sistem jika tersedia.
  if ! command -v chromium-browser >/dev/null 2>&1 && ! command -v chromium >/dev/null 2>&1; then
    sudo apt-get install -y chromium-browser || sudo apt-get install -y chromium || true
  fi
}

setup_whatsapp_bot() {
  ensure_env_file
  echo "=== Setup WhatsApp Bot ==="

  install_whatsapp_system_dependencies

  set_env_value "WHATSAPP_ENABLED" "true"

  local wa_admins
  read -rp "ADMIN_WHATSAPP_NUMBERS (pisahkan koma, contoh 62812...,62813...): " wa_admins
  if [ -n "${wa_admins}" ]; then
    set_env_value "ADMIN_WHATSAPP_NUMBERS" "${wa_admins}"
  fi

  local detected_chrome
  detected_chrome="$(command -v chromium-browser || command -v chromium || true)"
  if [ -n "${detected_chrome}" ]; then
    set_env_value "WHATSAPP_PUPPETEER_EXECUTABLE_PATH" "${detected_chrome}"
    echo "Chromium terdeteksi: ${detected_chrome}"
  else
    echo "Chromium tidak terdeteksi otomatis."
    echo "Isi manual WHATSAPP_PUPPETEER_EXECUTABLE_PATH di .env jika perlu."
  fi

  echo "Install/update dependency npm..."
  npm install

  echo "Setup WhatsApp selesai."
  echo "Jalankan WhatsApp bot dengan: npm run start:wa"
  echo "Saat pertama kali run, scan QR yang tampil di terminal."
}

git_update_project() {
  if [ ! -d "${PROJECT_DIR}/.git" ]; then
    echo "Repository git tidak ditemukan."
    return 1
  fi

  git pull --ff-only
  npm install
  echo "Update project selesai."
}

show_menu() {
  clear
  echo "=============================================="
  echo " BOT TELE SERVER PANEL"
  echo "=============================================="
  echo "Project : ${PROJECT_DIR}"
  echo "Service : ${SERVICE_NAME}"
  echo ""
  echo "1) Lihat konfigurasi .env"
  echo "2) Setup konfigurasi dasar (.env)"
  echo "3) Edit .env manual"
  echo "4) Install/Update dependency npm"
  echo "5) Validasi/migrasi data"
  echo "6) Install service systemd"
  echo "7) Start service"
  echo "8) Stop service"
  echo "9) Restart service"
  echo "10) Status service"
  echo "11) Lihat log terakhir"
  echo "12) Lihat log realtime"
  echo "13) Health check API"
  echo "14) Backup data + .env"
  echo "15) Update project dari git"
  echo "16) Setup WhatsApp bot"
  echo "0) Keluar"
  echo ""
}

main_loop() {
  while true; do
    show_menu
    read -rp "Pilih menu: " choice

    case "${choice}" in
      1)
        show_current_config
        pause_screen
        ;;
      2)
        configure_basic_env
        pause_screen
        ;;
      3)
        edit_env_file
        ;;
      4)
        install_or_update_dependencies
        pause_screen
        ;;
      5)
        run_data_check
        pause_screen
        ;;
      6)
        install_service_file
        pause_screen
        ;;
      7)
        service_start
        pause_screen
        ;;
      8)
        service_stop
        pause_screen
        ;;
      9)
        service_restart
        pause_screen
        ;;
      10)
        service_status
        pause_screen
        ;;
      11)
        service_logs
        pause_screen
        ;;
      12)
        service_logs_follow
        ;;
      13)
        health_check
        pause_screen
        ;;
      14)
        backup_data
        pause_screen
        ;;
      15)
        git_update_project
        pause_screen
        ;;
      16)
        setup_whatsapp_bot
        pause_screen
        ;;
      0)
        echo "Keluar dari panel."
        exit 0
        ;;
      *)
        echo "Pilihan tidak valid."
        pause_screen
        ;;
    esac
  done
}

install_panel_command() {
  sudo tee /usr/local/bin/panel >/dev/null <<EOF
#!/usr/bin/env bash
cd "${PROJECT_DIR}"
exec bash "${SCRIPT_PATH}" panel
EOF
  sudo chmod +x /usr/local/bin/panel
  sudo rm -f /usr/local/bin/bot
}

run_install() {
  cd "${PROJECT_DIR}"
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
  ensure_env_file

  echo "[6/7] Validate/migrate data"
  run_data_check

  echo "[7/7] Install command: panel"
  install_panel_command

  echo "Done"
  echo "Jalankan bot dengan: npm start"
  echo "Akses panel server cukup ketik: panel"
}

ensure_linux_systemd
if [ "${1:-}" = "panel" ]; then
  cd "${PROJECT_DIR}"
  main_loop
else
  run_install
fi
