# DNSTT / Slipstream Telegram Deployment Bot

A Telegram bot that deploys [DNSTT](https://github.com/bugfloyd/dnstt-deploy) or [Slipstream](https://github.com/Fox-Fig/slipstream-rust-deploy) tunnel servers on your VPS via SSH.

## Quick Start

You have two options:

1. **Use the hosted bot:** Open [@DNSTunnelGeneratorRobot](https://t.me/DNSTunnelGeneratorRobot) in Telegram and start deploying right away.

2. **Self-host your own instance (recommended):** Clone this repo and run the bot yourself. This way your server credentials never leave your machine.

## Features

- **DNSTT deployment** — SSH or SOCKS tunnel mode, returns the public key needed for client config
- **Slipstream deployment** — SSH, SOCKS (with optional auth), or Shadowsocks tunnel mode
- Interactive conversation flow with inline keyboard buttons
- Real-time deployment progress updates
- Automatic password/key message deletion for security
- SSH key auth via text paste or file upload

## Self-Hosting Setup

1. **Create a Telegram bot** via [@BotFather](https://t.me/BotFather) and get your bot token.

2. **Configure environment:**

   ```bash
   cp .env.example .env
   # Edit .env and add your bot token
   ```

3. **Install dependencies:**

   ```bash
   npm install
   ```

4. **Run:**
   ```bash
   npm start
   ```

## Bot Commands

| Command   | Description              |
| --------- | ------------------------ |
| `/start`  | Welcome message          |
| `/deploy` | Start a new deployment   |
| `/cancel` | Cancel current operation |

## Deployment Flow

1. Choose protocol (DNSTT or Slipstream)
2. Enter server IP
3. Enter SSH port (default: 22)
4. Choose auth method (Password / SSH Key)
5. Enter credentials
6. Enter nameserver domain
7. Enter MTU size (default: 1232)
8. Choose tunnel mode
9. (Slipstream only) Additional mode-specific options
10. Review summary and confirm
11. Bot connects via SSH and runs the deployment

## Requirements

- Node.js 18+
- The target server must be accessible via SSH as `root`
- The target server needs internet access (to download the deploy scripts)

## Notes

- **DNSTT** generates a public key after deployment — the bot will display it. You need this key for client configuration.
- **Slipstream** with Shadowsocks asks for port, password, and encryption method.
- If deploying Slipstream on a server that already has DNSTT installed, you must uninstall DNSTT first.
