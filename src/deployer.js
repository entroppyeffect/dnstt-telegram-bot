const { Client } = require("ssh2");

class ConflictError extends Error {
  constructor(existing) {
    super(`${existing.toUpperCase()} is already installed on this server.`);
    this.name = "ConflictError";
    this.existing = existing; // 'dnstt' or 'slipstream'
  }
}

const SCRIPTS = {
  dnstt:
    "https://raw.githubusercontent.com/bugfloyd/dnstt-deploy/main/dnstt-deploy.sh",
  slipstream:
    "https://raw.githubusercontent.com/Fox-Fig/slipstream-rust-deploy/master/slipstream-rust-deploy.sh",
};

function stripAnsi(str) {
  return str.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "");
}

function buildPrompts(params) {
  const prompts = [];

  if (params.protocol === "dnstt") {
    prompts.push({
      match: "Enter the nameserver subdomain",
      response: params.domain,
    });
    prompts.push({ match: "Enter MTU value", response: params.mtu });
    prompts.push({
      match: "Enter choice",
      response: params.tunnelMode === "socks" ? "1" : "2",
    });
  } else {
    prompts.push({ match: "Enter the domain", response: params.domain });
    const modeMap = { socks: "1", ssh: "2", shadowsocks: "3" };
    prompts.push({
      match: "Enter choice",
      response: modeMap[params.tunnelMode],
    });

    if (params.tunnelMode === "socks") {
      if (params.socksAuth) {
        prompts.push({
          match: "authentication for SOCKS proxy",
          response: "y",
        });
        prompts.push({
          match: "Enter SOCKS username",
          response: params.socksUsername,
        });
        prompts.push({
          match: "Enter SOCKS password",
          response: params.socksPassword,
        });
        prompts.push({
          match: "Confirm SOCKS password",
          response: params.socksPassword,
        });
      } else {
        prompts.push({
          match: "authentication for SOCKS proxy",
          response: "n",
        });
      }
    } else if (params.tunnelMode === "shadowsocks") {
      prompts.push({
        match: "Shadowsocks local port",
        response: params.ssPort,
      });
      prompts.push({
        match: "Enter Shadowsocks password",
        response: params.ssPassword,
      });
      prompts.push({
        match: "Confirm Shadowsocks password",
        response: params.ssPassword,
      });
      prompts.push({ match: "Enter choice", response: params.ssMethod });
    }
  }

  return prompts;
}

function deploy(sshConfig, params, onProgress) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let settled = false;

    const timeout = setTimeout(
      () => {
        if (!settled) {
          settled = true;
          conn.end();
          reject(new Error("Deployment timed out (15 minutes)"));
        }
      },
      15 * 60 * 1000,
    );

    function finish(err, result) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      conn.end();
      if (err) reject(err);
      else resolve(result);
    }

    conn.on("ready", () => {
      onProgress("Connected to server");

      const url = SCRIPTS[params.protocol];
      const cmd = `curl -fsSL '${url}' -o /tmp/tunnel-deploy.sh && bash /tmp/tunnel-deploy.sh`;

      const prompts = buildPrompts(params);
      let promptIndex = 0;
      let buffer = "";
      let output = "";
      let lastProgress = 0;

      conn.exec(cmd, { pty: { rows: 50, cols: 200 } }, (err, stream) => {
        if (err) return finish(err);

        stream.on("data", (data) => {
          const text = data.toString();
          output += text;
          buffer += text;

          // Fatal condition checks
          if (buffer.includes("This script must be run as root")) {
            return finish(
              new Error(
                "Script requires root privileges. Please connect as root.",
              ),
            );
          }
          if (buffer.includes("dnstt installation detected")) {
            return finish(new ConflictError("dnstt"));
          }

          // Process prompts sequentially
          while (promptIndex < prompts.length) {
            const { match, response } = prompts[promptIndex];
            const pos = buffer.indexOf(match);
            if (pos !== -1) {
              setTimeout(() => {
                try {
                  stream.write(response + "\n");
                } catch (e) {
                  /* stream may be closed */
                }
              }, 500);
              buffer = buffer.substring(pos + match.length);
              promptIndex++;
            } else {
              break;
            }
          }

          // Prevent buffer from growing unbounded
          if (buffer.length > 50000) {
            buffer = buffer.substring(buffer.length - 25000);
          }

          // Throttled progress updates
          const now = Date.now();
          if (now - lastProgress > 4000) {
            const clean = stripAnsi(text);
            const infoLines = clean.match(/\[INFO\].*/g);
            if (infoLines) {
              onProgress(infoLines[infoLines.length - 1]);
              lastProgress = now;
            }
          }
        });

        stream.stderr.on("data", (data) => {
          output += data.toString();
        });

        stream.on("close", () => {
          const result = parseOutput(output, params.protocol);
          if (result.success) {
            finish(null, result);
          } else {
            finish(
              new Error(
                result.error || "Deployment failed. Check server logs.",
              ),
            );
          }
        });
      });
    });

    conn.on("error", (err) => finish(err));

    const sshOptions = {
      host: sshConfig.host,
      port: sshConfig.port || 22,
      username: sshConfig.username || "root",
      readyTimeout: 30000,
      keepaliveInterval: 10000,
    };

    if (sshConfig.password) sshOptions.password = sshConfig.password;
    if (sshConfig.privateKey) sshOptions.privateKey = sshConfig.privateKey;

    conn.connect(sshOptions);
  });
}

function parseOutput(output, protocol) {
  const stripped = stripAnsi(output);

  const success =
    stripped.includes("SETUP COMPLETED SUCCESSFULLY") ||
    stripped.includes("COMPLETED SUCCESSFULLY");

  if (success) {
    const result = { success: true };

    if (protocol === "dnstt") {
      // Extract the public key — appears after "Public key content:" on the next line
      const keyMatch = stripped.match(
        /Public [Kk]ey [Cc]ontent:\s*\n\s*([^\n]+)/,
      );
      if (keyMatch) {
        result.publicKey = keyMatch[1].trim();
      }
    }

    return result;
  }

  const errorLines = stripped.match(/\[ERROR\].*/g);
  if (errorLines) {
    return { success: false, error: errorLines.join("\n") };
  }

  return {
    success: false,
    error:
      "Deployment did not complete successfully. Check server logs for details.",
  };
}

const crypto = require("crypto");

function generateUsername() {
  return "tun_" + crypto.randomBytes(4).toString("hex");
}

function generatePassword() {
  // Avoid shell-problematic characters: no quotes, backslashes, backticks, pipes, etc.
  const chars =
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const bytes = crypto.randomBytes(24);
  let password = "";
  for (let i = 0; i < 24; i++) {
    password += chars[bytes[i] % chars.length];
  }
  return password;
}

function createTunnelUser(sshConfig) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    const username = generateUsername();
    const password = generatePassword();
    let settled = false;

    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        conn.end();
        reject(new Error("Tunnel user creation timed out"));
      }
    }, 30000);

    function finish(err, result) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      conn.end();
      if (err) reject(err);
      else resolve(result);
    }

    conn.on("ready", () => {
      const cmd = `adduser --system --shell /usr/sbin/nologin --no-create-home ${username} 2>&1 && echo "${username}:${password}" | chpasswd 2>&1 && echo "TUNNEL_USER_CREATED"`;

      conn.exec(cmd, { pty: true }, (err, stream) => {
        if (err) return finish(err);

        let output = "";
        stream.on("data", (data) => {
          output += data.toString();
          if (output.includes("TUNNEL_USER_CREATED")) {
            finish(null, { username, password });
          }
        });

        stream.stderr.on("data", (data) => {
          output += data.toString();
        });

        stream.on("close", (code) => {
          if (!output.includes("TUNNEL_USER_CREATED")) {
            finish(new Error("Failed to create tunnel user: " + output.trim()));
          }
        });
      });
    });

    conn.on("error", (err) => reject(err));

    const sshOptions = {
      host: sshConfig.host,
      port: sshConfig.port || 22,
      username: sshConfig.username || "root",
      readyTimeout: 15000,
    };
    if (sshConfig.password) sshOptions.password = sshConfig.password;
    if (sshConfig.privateKey) sshOptions.privateKey = sshConfig.privateKey;

    conn.connect(sshOptions);
  });
}

function uninstallExisting(sshConfig, protocol, onProgress) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let settled = false;

    const timeout = setTimeout(
      () => {
        if (!settled) {
          settled = true;
          conn.end();
          reject(new Error("Uninstall timed out (10 minutes)"));
        }
      },
      10 * 60 * 1000,
    );

    function finish(err) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      conn.end();
      if (err) reject(err);
      else resolve();
    }

    conn.on("ready", () => {
      onProgress("Connected — uninstalling " + protocol.toUpperCase() + "...");

      let cmd;
      if (protocol === "dnstt") {
        // Direct uninstall commands for dnstt since the script menu is interactive
        cmd = [
          "systemctl stop dnstt-server 2>/dev/null || true",
          "systemctl disable dnstt-server 2>/dev/null || true",
          "rm -f /etc/systemd/system/dnstt-server.service",
          "systemctl stop danted 2>/dev/null || true",
          "systemctl disable danted 2>/dev/null || true",
          "rm -f /usr/local/bin/dnstt-server",
          "rm -f /usr/local/bin/dnstt-deploy",
          "rm -rf /etc/dnstt",
          "userdel dnstt 2>/dev/null || true",
          // Remove iptables rules for port 5300
          "iptables -D INPUT -p udp --dport 5300 -j ACCEPT 2>/dev/null || true",
          "IFACE=$(ip route | grep default | awk '{print $5}' | head -1)",
          "iptables -t nat -D PREROUTING -i $IFACE -p udp --dport 53 -j REDIRECT --to-ports 5300 2>/dev/null || true",
          "ip6tables -D INPUT -p udp --dport 5300 -j ACCEPT 2>/dev/null || true",
          "ip6tables -t nat -D PREROUTING -i $IFACE -p udp --dport 53 -j REDIRECT --to-ports 5300 2>/dev/null || true",
          "systemctl daemon-reload",
          "echo UNINSTALL_DONE",
        ].join(" && ");
      } else {
        // Direct uninstall commands for slipstream
        cmd = [
          "systemctl stop slipstream-rust-server 2>/dev/null || true",
          "systemctl disable slipstream-rust-server 2>/dev/null || true",
          "rm -f /etc/systemd/system/slipstream-rust-server.service",
          "systemctl stop danted 2>/dev/null || true",
          "systemctl disable danted 2>/dev/null || true",
          "systemctl stop shadowsocks-libev-server@config 2>/dev/null || true",
          "systemctl disable shadowsocks-libev-server@config 2>/dev/null || true",
          "rm -f /etc/systemd/system/shadowsocks-libev-server@config.service",
          "systemctl stop slipstream-restore-iptables 2>/dev/null || true",
          "systemctl disable slipstream-restore-iptables 2>/dev/null || true",
          "rm -f /etc/systemd/system/slipstream-restore-iptables.service",
          "rm -f /usr/local/bin/slipstream-server",
          "rm -f /usr/local/bin/slipstream-rust-deploy",
          "rm -f /usr/local/bin/slipstream-restore-iptables.sh",
          "rm -rf /etc/slipstream-rust",
          "rm -rf /opt/slipstream-rust",
          "userdel slipstream 2>/dev/null || true",
          "iptables -D INPUT -p udp --dport 5300 -j ACCEPT 2>/dev/null || true",
          "IFACE=$(ip route | grep default | awk '{print $5}' | head -1)",
          "iptables -t nat -D PREROUTING -i $IFACE -p udp --dport 53 -j REDIRECT --to-ports 5300 2>/dev/null || true",
          "ip6tables -D INPUT -p udp --dport 5300 -j ACCEPT 2>/dev/null || true",
          "ip6tables -t nat -D PREROUTING -i $IFACE -p udp --dport 53 -j REDIRECT --to-ports 5300 2>/dev/null || true",
          "systemctl daemon-reload",
          "echo UNINSTALL_DONE",
        ].join(" && ");
      }

      let output = "";
      conn.exec(cmd, { pty: true }, (err, stream) => {
        if (err) return finish(err);

        stream.on("data", (data) => {
          output += data.toString();
          if (output.includes("UNINSTALL_DONE")) {
            finish(null);
          }
        });

        stream.on("close", () => {
          finish(null);
        });
      });
    });

    conn.on("error", (err) => finish(err));

    const sshOptions = {
      host: sshConfig.host,
      port: sshConfig.port || 22,
      username: sshConfig.username || "root",
      readyTimeout: 30000,
      keepaliveInterval: 10000,
    };
    if (sshConfig.password) sshOptions.password = sshConfig.password;
    if (sshConfig.privateKey) sshOptions.privateKey = sshConfig.privateKey;

    conn.connect(sshOptions);
  });
}

module.exports = { deploy, createTunnelUser, uninstallExisting, ConflictError };
