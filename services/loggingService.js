'use strict';

const { getSetting } = require('./settingsService');

async function getLogChannel(guild, database) {
  const channelId = await getSetting(database, guild.id, 'logging.channelId', null);
  if (channelId) {
    const channel = guild.channels.cache.get(channelId);
    if (channel && channel.isTextBased()) return channel;
  }

  return (
    guild.channels.cache.find(
      (ch) => ch.name === process.env.LOGS_CHANNEL_NAME && ch.isTextBased(),
    ) || null
  );
}

async function isEventLoggingEnabled(database, guildId, key) {
  const enabled = await getSetting(database, guildId, 'logging.enabled', true);
  if (!enabled) return false;
  return getSetting(database, guildId, key, true);
}

function truncate(text, max = 1024) {
  if (!text) return text;
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

module.exports = {
  getLogChannel,
  isEventLoggingEnabled,
  truncate,
};
