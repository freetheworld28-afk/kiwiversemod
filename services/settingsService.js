'use strict';

const DEFAULT_SETTINGS = {
  'tickets.enabled': true,
  'tickets.categoryId': null,
  'tickets.staffRoleId': null,
  'tickets.transcriptChannelId': null,
  'tickets.logChannelId': null,
  'tickets.dmOnOpen': true,
  'tickets.dmOnClose': true,
  'tickets.allowMultiple': false,
  'tickets.maxOpenPerUser': 3,

  'moderation.enabled': true,
  'moderation.dmAffectedUsers': true,
  'moderation.logChannelId': null,

  // enabled/blockInvites default true because the slur+invite filter they
  // gate has always run unconditionally in features/contentFilter.js - a
  // default-off toggle would silently disable already-relied-upon
  // protection the moment these settings started being read. blockLinks/
  // spamProtection/massMentionProtection/capsProtection have no
  // implementation in the bot yet, so their default is moot either way.
  'automod.enabled': true,
  'automod.blockInvites': true,
  'automod.blockLinks': false,
  'automod.spamProtection': false,
  'automod.massMentionProtection': false,
  'automod.capsProtection': false,

  'logging.enabled': true,
  'logging.channelId': null,
  'logging.messageDelete': true,
  'logging.messageEdit': true,
  'logging.memberJoin': true,
  'logging.memberLeave': true,
  'logging.memberUpdate': true,
  'logging.moderation': true,
  'logging.tickets': true,
  'logging.giveaways': true,
  'logging.configChanges': true,
  'logging.robloxVerification': true,

  // enabled defaults true because a welcome message has always sent
  // unconditionally in guildMemberAdd.js - see the automod.enabled comment
  // above for the same reasoning (don't silently disable existing behavior
  // the moment this setting starts being read).
  'welcome.enabled': true,
  'welcome.channelId': null,
  'welcome.leaveChannelId': null,
  'welcome.message': 'Welcome {user} to {server}!',
  'welcome.leaveMessage': '{user} has left {server}.',
  'welcome.dmWelcome': false,
  'welcome.autoRoleId': null,

  'roles.verifiedRoleId': null,
  'roles.memberRoleId': null,
  'roles.robloxLinkedRoleId': null,

  'roblox.enabled': true,
  'roblox.maxAccountsPerDiscord': 10,
  'roblox.preventDuplicateLinks': true,
  'roblox.roleSync': false,

  'leveling.enabled': true,
  'leveling.xpPerMessage': 15,
  'leveling.cooldownSeconds': 60,
  'leveling.levelUpChannelId': null,
  'leveling.dmLevelUp': false,
  'leveling.ignoredChannelIds': [],
  'leveling.ignoredRoleIds': [],

  'economy.enabled': true,
  'economy.currencyName': 'Kiwi Coins',
  'economy.startingBalance': 1000,
  'economy.dailyReward': 250,

  'giveaways.enabled': true,
  'suggestions.enabled': true,
  'suggestions.channelId': null,
  'suggestions.dmStatusChanges': true,

  'starboard.enabled': false,
  'starboard.channelId': null,
  'starboard.requiredStars': 3,
  'starboard.emoji': '⭐',

  'customResponses.enabled': true,
};

function envBackedDefaults() {
  return {
    'tickets.categoryId': process.env.TICKET_CATEGORY_ID || null,
    'tickets.staffRoleId': process.env.TICKET_STAFF_ROLE_ID || null,
    'tickets.transcriptChannelId': process.env.TICKET_TRANSCRIPT_CHANNEL_ID || null,
    'moderation.logChannelName': process.env.LOGS_CHANNEL_NAME || null,
  };
}

async function ensureGuildDefaults(database, guildId) {
  if (!guildId) return;
  const db = await database;
  const defaults = { ...DEFAULT_SETTINGS, ...envBackedDefaults() };

  await db.exec('BEGIN');
  try {
    for (const [key, value] of Object.entries(defaults)) {
      await db.run(
        `INSERT OR IGNORE INTO guild_settings (guild_id, key, value)
         VALUES (?, ?, ?)`,
        guildId,
        key,
        JSON.stringify(value),
      );
    }
    await db.exec('COMMIT');
  } catch (error) {
    await db.exec('ROLLBACK');
    throw error;
  }
}

async function getSetting(database, guildId, key, fallback = null) {
  const db = await database;
  const row = await db.get(
    'SELECT value FROM guild_settings WHERE guild_id = ? AND key = ?',
    guildId,
    key,
  );
  if (!row) return fallback;
  try {
    return JSON.parse(row.value);
  } catch {
    return row.value;
  }
}

async function setSetting(database, guildId, key, value) {
  const db = await database;
  await db.run(
    `INSERT INTO guild_settings (guild_id, key, value, updated_at)
     VALUES (?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(guild_id, key)
     DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
    guildId,
    key,
    JSON.stringify(value),
  );
  return value;
}

async function getSettingsByPrefix(database, guildId, prefix) {
  const db = await database;
  const rows = await db.all(
    'SELECT key, value FROM guild_settings WHERE guild_id = ? AND key LIKE ? ORDER BY key',
    guildId,
    `${prefix}.%`,
  );
  const result = {};
  for (const row of rows) {
    const shortKey = row.key.slice(prefix.length + 1);
    try {
      result[shortKey] = JSON.parse(row.value);
    } catch {
      result[shortKey] = row.value;
    }
  }
  return result;
}

// Small TTL cache for getSettingsByPrefix(), shared by any feature that
// needs to check its guild settings on a high-frequency path (e.g. once per
// message) without turning that into a SQLite query per message. Not used
// by every caller - one-off reads (a slash command, a button handler) go
// straight to getSettingsByPrefix()/getSetting() since they're already
// infrequent relative to a message stream.
const prefixCache = new Map(); // `${guildId}:${prefix}` -> { value, expiresAt }
const PREFIX_CACHE_TTL_MS = 60_000;

async function getCachedSettingsByPrefix(database, guildId, prefix) {
  const key = `${guildId}:${prefix}`;
  const cached = prefixCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const value = await getSettingsByPrefix(database, guildId, prefix);
  prefixCache.set(key, { value, expiresAt: Date.now() + PREFIX_CACHE_TTL_MS });
  return value;
}

// Called after a dashboard write so the next message picks up the change
// instead of waiting out the TTL. A PATCH can touch arbitrary keys across
// prefixes, so this drops every cached prefix for the guild rather than
// trying to figure out which ones were affected.
function invalidateSettingsCache(guildId) {
  for (const key of prefixCache.keys()) {
    if (key.startsWith(`${guildId}:`)) prefixCache.delete(key);
  }
}

module.exports = {
  DEFAULT_SETTINGS,
  ensureGuildDefaults,
  getCachedSettingsByPrefix,
  invalidateSettingsCache,
  getSetting,
  setSetting,
  getSettingsByPrefix,
};
