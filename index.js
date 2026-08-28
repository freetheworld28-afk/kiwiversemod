'use strict';

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  Collection,
  ActivityType,
} = require('discord.js');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const NodeCache = require('node-cache');

// Environment variables
const {
  DISCORD_TOKEN,
  CLIENT_ID,
  GUILD_ID = '',
  LOGS_CHANNEL_NAME = 'logs',
  WELCOME_CHANNEL_NAME = 'welcome',
  GENERAL_CHANNEL_NAME = 'general',
  SUGGESTIONS_CHANNEL_NAME = 'suggestions',
  ANNOUNCEMENTS_CHANNEL_NAME = 'announcements',
} = process.env;

// Railway's normal application filesystem is ephemeral. Prefer an explicitly
// configured DB_FILE, otherwise automatically use /data/database.sqlite when a
// Railway volume is mounted at /data. Only fall back to the repo directory for
// local development.
const persistentDataDir = '/data';
const hasPersistentDataDir = (() => {
  try {
    return fs.existsSync(persistentDataDir) && fs.statSync(persistentDataDir).isDirectory();
  } catch {
    return false;
  }
})();

const DB_FILE = process.env.DB_FILE
  || (hasPersistentDataDir
    ? path.join(persistentDataDir, 'database.sqlite')
    : path.join(__dirname, 'database.sqlite'));

const dbDirectory = path.dirname(DB_FILE);
if (!fs.existsSync(dbDirectory)) fs.mkdirSync(dbDirectory, { recursive: true });

const isRailway = Boolean(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID || process.env.RAILWAY_SERVICE_ID);
const persistentStorage = DB_FILE.startsWith('/data/') || (!isRailway && !DB_FILE.startsWith('/app/'));

console.log(`💾 KiwiVerse database: ${DB_FILE}`);
if (isRailway && !persistentStorage) {
  console.error('🚨 PERSISTENCE WARNING: KiwiVerse is running on Railway without /data persistent storage.');
  console.error('🚨 XP, levels, applications, tickets, invites, Roblox links, settings and moderation history may be erased on the next deploy.');
  console.error('🚨 Add a Railway Volume mounted at /data. KiwiVerse will automatically use /data/database.sqlite.');
} else if (persistentStorage) {
  console.log('✅ Persistent database storage detected');
}

// Initialize Discord client
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildVoiceStates,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.GuildMember, Partials.Reaction, Partials.User],
});

// Initialize database
const database = open({ filename: DB_FILE, driver: sqlite3.Database });

// Cache for performance. This is deliberately non-persistent and is only for
// temporary runtime data such as cooldowns/invite snapshots. Authoritative bot
// history lives in SQLite.
const cache = new NodeCache({ stdTTL: 600 });

// Collections for commands and features
client.commands = new Collection();
client.features = new Collection();

// Load event handlers
const eventsPath = path.join(__dirname, 'events');
if (fs.existsSync(eventsPath)) {
  const eventFiles = fs.readdirSync(eventsPath).filter((file) => file.endsWith('.js'));
  for (const file of eventFiles) {
    const filePath = path.join(eventsPath, file);
    const event = require(filePath);
    if (event.once) {
      client.once(event.name, (...args) => event.execute(...args, client, database, cache));
    } else {
      client.on(event.name, (...args) => event.execute(...args, client, database, cache));
    }
  }
}

// Load command handlers
const commandsPath = path.join(__dirname, 'commands');
if (fs.existsSync(commandsPath)) {
  const commandFiles = fs.readdirSync(commandsPath).filter((file) => file.endsWith('.js'));
  for (const file of commandFiles) {
    const filePath = path.join(commandsPath, file);
    const command = require(filePath);
    if (command.data && command.execute) {
      client.commands.set(command.data.name, command);
    }
  }
}

// Load features
const featuresPath = path.join(__dirname, 'features');
if (fs.existsSync(featuresPath)) {
  const featureFiles = fs.readdirSync(featuresPath).filter((file) => file.endsWith('.js'));
  for (const file of featureFiles) {
    const filePath = path.join(featuresPath, file);
    const feature = require(filePath);
    if (feature.name) {
      client.features.set(feature.name, feature);
    }
  }
}

// Initialize database tables
async function initDatabase() {
  const db = await database;
  await db.exec(`
    -- Users and leveling
    CREATE TABLE IF NOT EXISTS users (
      discord_id TEXT PRIMARY KEY,
      username TEXT,
      xp INTEGER DEFAULT 0,
      level INTEGER DEFAULT 0,
      balance INTEGER DEFAULT 1000,
      last_message TIMESTAMP,
      last_daily TIMESTAMP,
      warnings INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- Verified users with Roblox
    CREATE TABLE IF NOT EXISTS verified_users (
      discord_id TEXT PRIMARY KEY,
      roblox_accounts TEXT DEFAULT '[]',
      active_roblox_id TEXT,
      verified_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- Moderation logs
    CREATE TABLE IF NOT EXISTS moderation_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      discord_id TEXT,
      action TEXT,
      moderator_id TEXT,
      reason TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- Giveaways
    CREATE TABLE IF NOT EXISTS giveaways (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id TEXT UNIQUE,
      channel_id TEXT,
      guild_id TEXT,
      prize TEXT,
      host_id TEXT,
      entries TEXT DEFAULT '[]',
      ends_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- Suggestions
    CREATE TABLE IF NOT EXISTS suggestions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT,
      message TEXT,
      upvotes INTEGER DEFAULT 0,
      downvotes INTEGER DEFAULT 0,
      status TEXT DEFAULT 'pending',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- Tickets
    CREATE TABLE IF NOT EXISTS tickets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id TEXT UNIQUE,
      user_id TEXT,
      guild_id TEXT,
      status TEXT DEFAULT 'open',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      closed_at TIMESTAMP
    );

    -- Starboard
    CREATE TABLE IF NOT EXISTS starboard (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      original_message_id TEXT UNIQUE,
      starboard_message_id TEXT,
      channel_id TEXT,
      author_id TEXT,
      stars INTEGER DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- Reaction roles
    CREATE TABLE IF NOT EXISTS reaction_roles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id TEXT,
      emoji TEXT,
      role_id TEXT,
      guild_id TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- Auto-responses
    CREATE TABLE IF NOT EXISTS autoresponses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trigger TEXT UNIQUE,
      response TEXT,
      guild_id TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- Mutes/bans tracking
    CREATE TABLE IF NOT EXISTS infractions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      discord_id TEXT,
      type TEXT,
      reason TEXT,
      moderator_id TEXT,
      expires_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- Runtime/persistence metadata. This lets us prove whether the same database
    -- survived a restart/deployment instead of silently starting from scratch.
    CREATE TABLE IF NOT EXISTS bot_metadata (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  const installIdRow = await db.get("SELECT value FROM bot_metadata WHERE key = 'install_id'");
  if (!installIdRow) {
    const installId = require('crypto').randomBytes(12).toString('hex');
    await db.run(
      "INSERT INTO bot_metadata (key, value, updated_at) VALUES ('install_id', ?, CURRENT_TIMESTAMP)",
      installId,
    );
    console.log(`🆕 Created database install ID ${installId}`);
  } else {
    console.log(`♻️ Reusing persistent database install ID ${installIdRow.value}`);
  }

  await db.run(
    `INSERT INTO bot_metadata (key, value, updated_at)
     VALUES ('last_start', ?, CURRENT_TIMESTAMP)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
    new Date().toISOString(),
  );

  console.log('✅ Database initialized');
}

// Connect to Discord
client.login(DISCORD_TOKEN);

// Flush pending in-memory leveling XP before the process actually exits, so
// a restart/redeploy (SIGTERM from PM2/Railway/Docker) or a manual Ctrl-C
// never loses XP that hasn't hit its periodic flush yet.
const levelingService = require('./services/levelingService');
let shuttingDown = false;
async function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${signal} received - flushing pending leveling XP before exit...`);
  const timeout = new Promise((resolve) => setTimeout(resolve, 4000));
  try {
    await Promise.race([levelingService.shutdown(database), timeout]);
  } catch (error) {
    console.error('Error during leveling shutdown flush:', error);
  }
  process.exit(0);
}
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('beforeExit', () => {
  if (shuttingDown) return;
  levelingService.flush(database).catch((error) => console.error('beforeExit leveling flush failed:', error));
});

// Export for use in events and commands
module.exports = { client, database, cache, initDatabase, DB_FILE, persistentStorage };
