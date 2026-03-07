const TelegramBot = require("node-telegram-bot-api");
const {
  deploy,
  createTunnelUser,
  uninstallExisting,
  ConflictError,
} = require("./deployer");
const fs = require("fs");
const os = require("os");
const path = require("path");

const sessions = new Map();

function getSession(chatId) {
  if (!sessions.has(chatId)) {
    sessions.set(chatId, { state: "IDLE", data: {} });
  }
  return sessions.get(chatId);
}

function resetSession(chatId) {
  sessions.set(chatId, { state: "IDLE", data: {} });
}

// --- Validation helpers ---

function isValidHost(host) {
  return (
    /^(\d{1,3}\.){3}\d{1,3}$/.test(host) ||
    /^[a-zA-Z0-9][a-zA-Z0-9.\-]+$/.test(host)
  );
}

function isValidPort(port) {
  const num = parseInt(port);
  return !isNaN(num) && num >= 1 && num <= 65535;
}

function isValidDomain(domain) {
  return /^[a-zA-Z0-9][a-zA-Z0-9.\-]*\.[a-zA-Z]{2,}$/.test(domain);
}

function isValidMTU(mtu) {
  const num = parseInt(mtu);
  return !isNaN(num) && num >= 100 && num <= 65535;
}

// --- Message helpers ---

function sendModeSelection(bot, chatId, session) {
  const buttons =
    session.data.protocol === "dnstt"
      ? [
          [
            { text: "🔒 SSH", callback_data: "mode:ssh" },
            { text: "🧦 SOCKS", callback_data: "mode:socks" },
          ],
        ]
      : [
          [
            { text: "🔒 SSH", callback_data: "mode:ssh" },
            { text: "🧦 SOCKS", callback_data: "mode:socks" },
          ],
          [{ text: "🌑 Shadowsocks", callback_data: "mode:shadowsocks" }],
        ];

  bot.sendMessage(chatId, "🔧 Choose tunnel mode:", {
    reply_markup: { inline_keyboard: buttons },
  });
}

function handleModeSelected(bot, chatId, session) {
  const { protocol, tunnelMode } = session.data;

  if (protocol === "slipstream" && tunnelMode === "socks") {
    session.state = "SELECT_SOCKS_AUTH";
    bot.sendMessage(chatId, "🔐 Enable SOCKS proxy authentication?", {
      reply_markup: {
        inline_keyboard: [
          [
            { text: "✅ Yes", callback_data: "socksauth:yes" },
            { text: "❌ No", callback_data: "socksauth:no" },
          ],
        ],
      },
    });
  } else if (protocol === "slipstream" && tunnelMode === "shadowsocks") {
    session.state = "ENTER_SS_PORT";
    bot.sendMessage(chatId, "🔌 Enter Shadowsocks local port:", {
      reply_markup: {
        inline_keyboard: [
          [{ text: "Default (8388)", callback_data: "ssport:default" }],
        ],
      },
    });
  } else {
    session.state = "CONFIRM";
    sendConfirmation(bot, chatId, session);
  }
}

function sendConfirmation(bot, chatId, session) {
  const d = session.data;
  const SS_METHODS = {
    1: "aes-256-gcm",
    2: "aes-128-gcm",
    3: "chacha20-ietf-poly1305",
    4: "aes-256-cfb",
    5: "aes-128-cfb",
  };

  let summary = "📋 *Deployment Summary*\n\n";
  summary += `*Protocol:* ${d.protocol.toUpperCase()}\n`;
  summary += `*Server:* \`${d.sshUser}@${d.serverIp}:${d.sshPort}\`\n`;
  summary += `*Auth:* ${d.authMethod === "password" ? "Password" : "SSH Key"}\n`;
  summary += `*Domain:* ${d.domain}\n`;
  summary += `*MTU:* ${d.mtu}\n`;
  summary += `*Tunnel Mode:* ${d.tunnelMode}\n`;

  if (d.protocol === "slipstream" && d.tunnelMode === "socks") {
    summary += `*SOCKS Auth:* ${d.socksAuth ? "Enabled (" + d.socksUsername + ")" : "Disabled"}\n`;
  }
  if (d.tunnelMode === "shadowsocks") {
    summary += `*SS Port:* ${d.ssPort}\n`;
    summary += `*SS Encryption:* ${SS_METHODS[d.ssMethod]}\n`;
  }

  summary += "\n⚠️ This will install and configure the tunnel on your server.";

  bot.sendMessage(chatId, summary, {
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: [
        [
          { text: "✅ Deploy", callback_data: "confirm:deploy" },
          { text: "❌ Cancel", callback_data: "confirm:cancel" },
        ],
      ],
    },
  });
}

async function runDeployWithConflictHandling(
  bot,
  chatId,
  statusMsg,
  sshConfig,
  deployParams,
  onProgress,
) {
  try {
    return await deploy(sshConfig, deployParams, onProgress);
  } catch (err) {
    if (!(err instanceof ConflictError)) throw err;

    // Ask user whether to uninstall the conflicting protocol
    const existing = err.existing.toUpperCase();
    await bot.editMessageText(
      `⚠️ *${existing} is already installed* on this server.\n\nDo you want to uninstall ${existing} first and then install ${deployParams.protocol.toUpperCase()}?`,
      {
        chat_id: chatId,
        message_id: statusMsg.message_id,
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "✅ Uninstall & Continue",
                callback_data: "conflict:yes",
              },
              { text: "❌ Cancel", callback_data: "conflict:no" },
            ],
          ],
        },
      },
    );

    // Wait for user response via a one-time callback listener
    const userChoice = await new Promise((resolve) => {
      const handler = (query) => {
        if (query.message.chat.id !== chatId) return;
        if (!query.data.startsWith("conflict:")) return;
        bot.removeListener("callback_query", handler);
        bot.answerCallbackQuery(query.id);
        resolve(query.data.split(":")[1]);
      };
      bot.on("callback_query", handler);
    });

    if (userChoice !== "yes") {
      await bot.editMessageText("❌ Deployment cancelled.", {
        chat_id: chatId,
        message_id: statusMsg.message_id,
      });
      throw new Error("CONFLICT_CANCELLED");
    }

    // Uninstall existing protocol
    await bot.editMessageText(`⏳ Uninstalling ${existing}...`, {
      chat_id: chatId,
      message_id: statusMsg.message_id,
    });

    await uninstallExisting(sshConfig, err.existing, onProgress);

    await bot.editMessageText(
      `✅ ${existing} uninstalled.\n\n⏳ Now deploying ${deployParams.protocol.toUpperCase()}...`,
      {
        chat_id: chatId,
        message_id: statusMsg.message_id,
      },
    );

    // Retry the deployment
    return await deploy(sshConfig, deployParams, onProgress);
  }
}

async function startDeployment(bot, chatId, session) {
  session.state = "DEPLOYING";
  const d = session.data;

  const statusMsg = await bot.sendMessage(
    chatId,
    "⏳ Starting deployment...\n\n🔌 Connecting to server...",
  );

  const sshConfig = {
    host: d.serverIp,
    port: d.sshPort,
    username: d.sshUser,
  };
  if (d.authMethod === "password") {
    sshConfig.password = d.password;
  } else {
    sshConfig.privateKey = d.privateKey;
  }

  const deployParams = {
    protocol: d.protocol,
    domain: d.domain,
    mtu: d.mtu,
    tunnelMode: d.tunnelMode,
    socksAuth: d.socksAuth || false,
    socksUsername: d.socksUsername || "",
    socksPassword: d.socksPassword || "",
    ssPort: d.ssPort || "8388",
    ssPassword: d.ssPassword || "",
    ssMethod: d.ssMethod || "1",
  };

  let lastUpdate = 0;
  const onProgress = async (message) => {
    const now = Date.now();
    if (now - lastUpdate < 3000) return;
    lastUpdate = now;
    try {
      await bot.editMessageText(`⏳ Deploying...\n\n${message}`, {
        chat_id: chatId,
        message_id: statusMsg.message_id,
      });
    } catch (e) {
      /* ignore edit errors */
    }
  };

  try {
    const result = await runDeployWithConflictHandling(
      bot,
      chatId,
      statusMsg,
      sshConfig,
      deployParams,
      onProgress,
    );

    try {
      await bot.editMessageText("⏳ Deploying...\n\nCreating tunnel user...", {
        chat_id: chatId,
        message_id: statusMsg.message_id,
      });
    } catch (e) {
      /* ignore */
    }

    const tunnelUser = await createTunnelUser(sshConfig);

    let msg = "✅ *Deployment Completed Successfully!*\n\n";
    msg += `*Protocol:* ${d.protocol.toUpperCase()}\n`;
    msg += `*Server:* \`${d.serverIp}\`\n`;
    msg += `*SSH Port:* \`${d.sshPort}\`\n`;
    msg += `*Domain:* \`${d.domain}\`\n`;
    msg += `*Mode:* ${d.tunnelMode}\n\n`;

    msg += "👤 *Tunnel User Credentials:*\n";
    msg += `Username: \`${tunnelUser.username}\`\n`;
    msg += `Password: \`${tunnelUser.password}\`\n\n`;

    if (result.publicKey) {
      msg += "🔑 *Public Key:*\n";
      msg += "`" + result.publicKey + "`\n\n";
    }

    msg += "_Save this info — you need it to set up your client config._";

    await bot.editMessageText(msg, {
      chat_id: chatId,
      message_id: statusMsg.message_id,
      parse_mode: "Markdown",
    });
  } catch (err) {
    if (err.message !== "CONFLICT_CANCELLED") {
      await bot.editMessageText(`❌ *Deployment Failed*\n\n${err.message}`, {
        chat_id: chatId,
        message_id: statusMsg.message_id,
        parse_mode: "Markdown",
      });
    }
  } finally {
    // Clear sensitive data
    resetSession(chatId);
  }
}

// --- Main bot creation ---

function createBot(token) {
  const bot = new TelegramBot(token, { polling: true });

  // /start
  bot.onText(/\/start/, (msg) => {
    bot.sendMessage(
      msg.chat.id,
      "👋 Welcome to the Tunnel Deployment Bot!\n\n" +
        "I can deploy DNSTT or Slipstream tunnel servers on your VPS via SSH.\n\n" +
        "/deploy - Start a new deployment\n" +
        "/cancel - Cancel current operation",
    );
  });

  // /cancel
  bot.onText(/\/cancel/, (msg) => {
    resetSession(msg.chat.id);
    bot.sendMessage(msg.chat.id, "❌ Operation cancelled.");
  });

  // /deploy
  bot.onText(/\/deploy/, (msg) => {
    const chatId = msg.chat.id;
    const session = getSession(chatId);

    if (session.state === "DEPLOYING") {
      bot.sendMessage(
        chatId,
        "⏳ A deployment is already in progress. Please wait.",
      );
      return;
    }

    resetSession(chatId);
    const s = getSession(chatId);
    s.state = "SELECT_PROTOCOL";

    bot.sendMessage(chatId, "🚀 Choose the tunnel protocol to deploy:", {
      reply_markup: {
        inline_keyboard: [
          [
            { text: "🔷 DNSTT", callback_data: "proto:dnstt" },
            { text: "🟢 Slipstream", callback_data: "proto:slipstream" },
          ],
        ],
      },
    });
  });

  // --- Callback queries (button clicks) ---
  bot.on("callback_query", async (query) => {
    const chatId = query.message.chat.id;
    const session = getSession(chatId);
    const data = query.data;

    await bot.answerCallbackQuery(query.id);

    // Protocol selection
    if (data.startsWith("proto:") && session.state === "SELECT_PROTOCOL") {
      session.data.protocol = data.split(":")[1];
      session.state = "ENTER_IP";
      await bot.sendMessage(
        chatId,
        `Selected: *${session.data.protocol.toUpperCase()}*\n\n🖥 Enter the server IP address:`,
        { parse_mode: "Markdown" },
      );
      return;
    }

    // Default port
    if (data === "port:default" && session.state === "ENTER_PORT") {
      session.data.sshPort = 22;
      session.state = "ENTER_USER";
      await bot.sendMessage(chatId, "👤 Enter SSH username:", {
        reply_markup: {
          inline_keyboard: [
            [{ text: "Default (root)", callback_data: "user:default" }],
          ],
        },
      });
      return;
    }

    // Default SSH user
    if (data === "user:default" && session.state === "ENTER_USER") {
      session.data.sshUser = "root";
      session.state = "SELECT_AUTH";
      await bot.sendMessage(chatId, "🔐 Choose authentication method:", {
        reply_markup: {
          inline_keyboard: [
            [
              { text: "🔑 Password", callback_data: "auth:password" },
              { text: "📄 SSH Key", callback_data: "auth:key" },
            ],
          ],
        },
      });
      return;
    }

    // Auth method
    if (data.startsWith("auth:") && session.state === "SELECT_AUTH") {
      session.data.authMethod = data.split(":")[1];
      if (session.data.authMethod === "password") {
        session.state = "ENTER_PASSWORD";
        await bot.sendMessage(
          chatId,
          "🔒 Enter the SSH password:\n\n_Your message will be deleted for security._",
          { parse_mode: "Markdown" },
        );
      } else {
        session.state = "ENTER_SSH_KEY";
        await bot.sendMessage(
          chatId,
          "📄 Send your SSH private key:\n\nPaste it as text or upload as a file.\n_Your message will be deleted for security._",
          { parse_mode: "Markdown" },
        );
      }
      return;
    }

    // Default MTU
    if (data === "mtu:default" && session.state === "ENTER_MTU") {
      session.data.mtu = "1232";
      session.state = "SELECT_MODE";
      sendModeSelection(bot, chatId, session);
      return;
    }

    // Tunnel mode
    if (data.startsWith("mode:") && session.state === "SELECT_MODE") {
      session.data.tunnelMode = data.split(":")[1];
      handleModeSelected(bot, chatId, session);
      return;
    }

    // SOCKS auth toggle (Slipstream only)
    if (
      data.startsWith("socksauth:") &&
      session.state === "SELECT_SOCKS_AUTH"
    ) {
      const auth = data.split(":")[1] === "yes";
      session.data.socksAuth = auth;
      if (auth) {
        session.state = "ENTER_SOCKS_USER";
        await bot.sendMessage(chatId, "👤 Enter SOCKS proxy username:");
      } else {
        session.state = "CONFIRM";
        sendConfirmation(bot, chatId, session);
      }
      return;
    }

    // Default SS port
    if (data === "ssport:default" && session.state === "ENTER_SS_PORT") {
      session.data.ssPort = "8388";
      session.state = "ENTER_SS_PASS";
      await bot.sendMessage(chatId, "🔒 Enter the Shadowsocks password:");
      return;
    }

    // SS encryption method
    if (data.startsWith("ssmethod:") && session.state === "SELECT_SS_METHOD") {
      session.data.ssMethod = data.split(":")[1];
      session.state = "CONFIRM";
      sendConfirmation(bot, chatId, session);
      return;
    }

    // Confirm deploy
    if (data === "confirm:deploy" && session.state === "CONFIRM") {
      startDeployment(bot, chatId, session);
      return;
    }

    // Confirm cancel
    if (data === "confirm:cancel" && session.state === "CONFIRM") {
      resetSession(chatId);
      await bot.sendMessage(chatId, "❌ Deployment cancelled.");
      return;
    }
  });

  // --- Text messages ---
  bot.on("message", async (msg) => {
    if (!msg.text || msg.text.startsWith("/")) return;

    const chatId = msg.chat.id;
    const session = getSession(chatId);
    const text = msg.text.trim();

    switch (session.state) {
      case "ENTER_IP": {
        if (!isValidHost(text)) {
          await bot.sendMessage(
            chatId,
            "⚠️ Invalid IP or hostname. Please try again:",
          );
          return;
        }
        session.data.serverIp = text;
        session.state = "ENTER_PORT";
        await bot.sendMessage(chatId, "🔌 Enter SSH port:", {
          reply_markup: {
            inline_keyboard: [
              [{ text: "Default (22)", callback_data: "port:default" }],
            ],
          },
        });
        break;
      }

      case "ENTER_PORT": {
        if (!isValidPort(text)) {
          await bot.sendMessage(
            chatId,
            "⚠️ Invalid port number (1-65535). Try again:",
          );
          return;
        }
        session.data.sshPort = parseInt(text);
        session.state = "ENTER_USER";
        await bot.sendMessage(chatId, "👤 Enter SSH username:", {
          reply_markup: {
            inline_keyboard: [
              [{ text: "Default (root)", callback_data: "user:default" }],
            ],
          },
        });
        break;
      }

      case "ENTER_USER": {
        session.data.sshUser = text;
        session.state = "SELECT_AUTH";
        await bot.sendMessage(chatId, "🔐 Choose authentication method:", {
          reply_markup: {
            inline_keyboard: [
              [
                { text: "🔑 Password", callback_data: "auth:password" },
                { text: "📄 SSH Key", callback_data: "auth:key" },
              ],
            ],
          },
        });
        break;
      }

      case "ENTER_PASSWORD": {
        session.data.password = text;
        session.state = "ENTER_DOMAIN";
        try {
          await bot.deleteMessage(chatId, msg.message_id);
        } catch (e) {
          /* may lack perms */
        }
        await bot.sendMessage(
          chatId,
          "🔒 Password received.\n\n🌐 Enter the nameserver domain (e.g., t.example.com):",
        );
        break;
      }

      case "ENTER_SSH_KEY": {
        if (!text.includes("PRIVATE KEY")) {
          await bot.sendMessage(
            chatId,
            '⚠️ Does not look like a valid SSH private key.\nIt should contain "-----BEGIN ... PRIVATE KEY-----".\n\nPaste the key or upload as a file:',
          );
          return;
        }
        session.data.privateKey = text;
        session.state = "ENTER_DOMAIN";
        try {
          await bot.deleteMessage(chatId, msg.message_id);
        } catch (e) {
          /* may lack perms */
        }
        await bot.sendMessage(
          chatId,
          "🔑 SSH key received.\n\n🌐 Enter the nameserver domain (e.g., t.example.com):",
        );
        break;
      }

      case "ENTER_DOMAIN": {
        if (!isValidDomain(text)) {
          await bot.sendMessage(
            chatId,
            "⚠️ Invalid domain format. Example: t.example.com",
          );
          return;
        }
        session.data.domain = text;
        session.state = "ENTER_MTU";
        await bot.sendMessage(chatId, "📏 Enter MTU size:", {
          reply_markup: {
            inline_keyboard: [
              [{ text: "Default (1232)", callback_data: "mtu:default" }],
            ],
          },
        });
        break;
      }

      case "ENTER_MTU": {
        if (!isValidMTU(text)) {
          await bot.sendMessage(
            chatId,
            "⚠️ Invalid MTU (100-65535). Try again:",
          );
          return;
        }
        session.data.mtu = text;
        session.state = "SELECT_MODE";
        sendModeSelection(bot, chatId, session);
        break;
      }

      case "ENTER_SOCKS_USER": {
        session.data.socksUsername = text;
        session.state = "ENTER_SOCKS_PASS";
        await bot.sendMessage(chatId, "🔒 Enter SOCKS proxy password:");
        break;
      }

      case "ENTER_SOCKS_PASS": {
        session.data.socksPassword = text;
        try {
          await bot.deleteMessage(chatId, msg.message_id);
        } catch (e) {
          /* may lack perms */
        }
        session.state = "CONFIRM";
        sendConfirmation(bot, chatId, session);
        break;
      }

      case "ENTER_SS_PORT": {
        if (!isValidPort(text)) {
          await bot.sendMessage(
            chatId,
            "⚠️ Invalid port (1-65535). Try again:",
          );
          return;
        }
        session.data.ssPort = text;
        session.state = "ENTER_SS_PASS";
        await bot.sendMessage(chatId, "🔒 Enter the Shadowsocks password:");
        break;
      }

      case "ENTER_SS_PASS": {
        session.data.ssPassword = text;
        try {
          await bot.deleteMessage(chatId, msg.message_id);
        } catch (e) {
          /* may lack perms */
        }
        session.state = "SELECT_SS_METHOD";
        await bot.sendMessage(
          chatId,
          "🔐 Choose Shadowsocks encryption method:",
          {
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: "aes-256-gcm (recommended)",
                    callback_data: "ssmethod:1",
                  },
                ],
                [{ text: "aes-128-gcm", callback_data: "ssmethod:2" }],
                [
                  {
                    text: "chacha20-ietf-poly1305",
                    callback_data: "ssmethod:3",
                  },
                ],
                [{ text: "aes-256-cfb", callback_data: "ssmethod:4" }],
                [{ text: "aes-128-cfb", callback_data: "ssmethod:5" }],
              ],
            },
          },
        );
        break;
      }

      case "DEPLOYING": {
        await bot.sendMessage(
          chatId,
          "⏳ Deployment in progress. Please wait...",
        );
        break;
      }

      default: {
        await bot.sendMessage(
          chatId,
          "Use /deploy to start a new deployment or /help for info.",
        );
        break;
      }
    }
  });

  // --- File uploads (SSH key) ---
  bot.on("document", async (msg) => {
    const chatId = msg.chat.id;
    const session = getSession(chatId);

    if (session.state !== "ENTER_SSH_KEY") return;

    try {
      const tempDir = os.tmpdir();
      const filePath = await bot.downloadFile(msg.document.file_id, tempDir);
      const keyContent = fs.readFileSync(filePath, "utf8");

      // Clean up temp file immediately
      try {
        fs.unlinkSync(filePath);
      } catch (e) {
        /* best effort */
      }

      if (!keyContent.includes("PRIVATE KEY")) {
        await bot.sendMessage(
          chatId,
          "⚠️ This file does not contain a valid SSH private key. Please try again.",
        );
        return;
      }

      session.data.privateKey = keyContent;
      session.state = "ENTER_DOMAIN";
      try {
        await bot.deleteMessage(chatId, msg.message_id);
      } catch (e) {
        /* may lack perms */
      }
      await bot.sendMessage(
        chatId,
        "🔑 SSH key received.\n\n🌐 Enter the nameserver domain (e.g., t.example.com):",
      );
    } catch (err) {
      await bot.sendMessage(
        chatId,
        "❌ Failed to read the file. Please paste the key as text or try uploading again.",
      );
    }
  });

  return bot;
}

module.exports = { createBot };
