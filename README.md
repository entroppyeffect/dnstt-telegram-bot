# DNSTT / Slipstream Telegram Deployment Bot

A Telegram bot that deploys [DNSTT](https://github.com/bugfloyd/dnstt-deploy) or [Slipstream](https://github.com/Fox-Fig/slipstream-rust-deploy) tunnel servers on your VPS via SSH.

## Why Use This?

- **Can't SSH to your server?** Under heavy internet restrictions, directly SSHing into a server can be difficult or impossible. This bot handles the SSH connection for you — all you need is Telegram access.
- **Fast setup with a simple GUI.** No terminal skills needed. The bot walks you through the entire server setup with interactive buttons — just tap and deploy.
- **Safe, shareable configs.** The bot creates dedicated nologin, no-shell system users with random credentials for each deployment. This means you can safely share tunnel configs with others without exposing your server's root access.

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
4. Enter SSH username (default: root)
5. Choose auth method (Password / SSH Key)
6. Enter credentials
7. Enter nameserver domain
8. Enter MTU size (default: 1232)
9. Choose tunnel mode
10. (Slipstream only) Additional mode-specific options
11. Review summary and confirm
12. Bot connects via SSH and runs the deployment
13. A nologin tunnel user is created with random credentials
14. All connection info is displayed in one message

## Requirements

- Node.js 18+
- The target server must be accessible via SSH (root or a user with sudo/root privileges)
- The target server needs internet access (to download the deploy scripts)

## Notes

- **DNSTT** generates a public key after deployment — the bot will display it along with the tunnel user credentials and domain. You need all of this to set up your client config.
- **Slipstream** with Shadowsocks asks for port, password, and encryption method.
- If a conflicting protocol is already installed (e.g., DNSTT when deploying Slipstream), the bot will ask you to uninstall it first and handle the process automatically.
- After deployment, a nologin system user with a random username and strong password is created on the server for tunnel authentication.
