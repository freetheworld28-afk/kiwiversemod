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

const DB_FILE = path.join(__dirname, 'database.sqlite');

// Initialize Discord client
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildVoiceStates,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.GuildMember],
});

// Initialize database
const database = open({ filename: DB_FILE, driver: sqlite3.Database });

// Cache for performance
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
  `);
  console.log('✅ Database initialized');
}

// Connect to Discord
client.login(DISCORD_TOKEN);

// Export for use in events and commands
module.exports = { client, database, cache, initDatabase };

