require("dotenv").config();
const { createBot } = require("./bot");

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error(
    "Error: TELEGRAM_BOT_TOKEN is not set. Copy .env.example to .env and add your token.",
  );
  process.exit(1);
}

createBot(token);
console.log("Bot is running...");
