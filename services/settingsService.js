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

  'automod.enabled': false,
  'automod.blockInvites': false,
  'automod.blockLinks': false,
  'automod.spamProtection': false,
  'automod.massMentionProtection': false,
  'automod.capsProtection': false,

  'logging.enabled': false,
  'logging.channelId': null,
  'logging.messageDelete': true,
  'logging.messageEdit': true,
  'logging.memberJoin': true,
  'logging.memberLeave': true,
  'logging.moderation': true,
  'logging.tickets': true,
  'logging.robloxVerification': true,

  'welcome.enabled': false,
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

module.exports = {
  DEFAULT_SETTINGS,
  ensureGuildDefaults,
  getSetting,
  setSetting,
  getSettingsByPrefix,
};
