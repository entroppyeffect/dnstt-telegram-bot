#!/bin/bash
set -e

APP_NAME="dnstt-telegram-bot"
APP_DIR="/opt/$APP_NAME"
REPO_URL="https://github.com/entroppyeffect/dnstt-telegram-bot.git"

echo "============================================"
echo "  DNSTT Telegram Bot - Deployment Script"
echo "============================================"
echo ""

# Check root
if [[ $EUID -ne 0 ]]; then
  echo "Error: This script must be run as root."
  exit 1
fi

# Ask for bot token
read -rp "Enter your Telegram Bot Token: " BOT_TOKEN
if [[ -z "$BOT_TOKEN" ]]; then
  echo "Error: Bot token cannot be empty."
  exit 1
fi

echo ""
echo "[1/5] Installing Node.js..."
if command -v node &>/dev/null; then
  NODE_VER=$(node -v)
  echo "Node.js $NODE_VER is already installed."
else
  if command -v apt &>/dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt install -y nodejs
  elif command -v dnf &>/dev/null; then
    curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
    dnf install -y nodejs
  elif command -v yum &>/dev/null; then
    curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
    yum install -y nodejs
  else
    echo "Error: Unsupported package manager. Install Node.js 18+ manually."
    exit 1
  fi
fi

echo ""
echo "[2/5] Installing PM2..."
if command -v pm2 &>/dev/null; then
  echo "PM2 is already installed."
else
  npm install -g pm2
fi

echo ""
echo "[3/5] Cloning repository..."
if [[ -d "$APP_DIR" ]]; then
  echo "Directory exists. Pulling latest changes..."
  cd "$APP_DIR"
  git pull
else
  git clone "$REPO_URL" "$APP_DIR"
  cd "$APP_DIR"
fi

echo ""
echo "[4/5] Installing dependencies..."
cd "$APP_DIR"
npm install --production

echo ""
echo "[5/5] Configuring and starting bot..."

# Create .env
cat > "$APP_DIR/.env" <<EOF
TELEGRAM_BOT_TOKEN=$BOT_TOKEN
EOF
chmod 600 "$APP_DIR/.env"

# Stop existing instance if running
pm2 delete "$APP_NAME" 2>/dev/null || true

# Start with PM2
cd "$APP_DIR"
pm2 start src/index.js --name "$APP_NAME"
pm2 save

# Setup PM2 startup service
pm2 startup -u root --hp /root 2>/dev/null || pm2 startup
pm2 save

echo ""
echo "============================================"
echo "  Deployment Complete!"
echo "============================================"
echo ""
echo "  Bot is running as: $APP_NAME"
echo "  Install directory: $APP_DIR"
echo ""
echo "  Useful commands:"
echo "    pm2 status          - Check bot status"
echo "    pm2 logs $APP_NAME  - View logs"
echo "    pm2 restart $APP_NAME - Restart bot"
echo "    pm2 stop $APP_NAME  - Stop bot"
echo ""
