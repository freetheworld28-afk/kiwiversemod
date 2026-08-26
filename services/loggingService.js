'use strict';

const { getSetting } = require('./settingsService');

// `category` picks a dedicated log channel (e.g. "message" -> a channel
// literally named "message-logs", matching how Dyno-style setups split logs
// by type) before falling back to the single generic logs channel.
async function getLogChannel(guild, database, category = null) {
  if (category) {
    const categoryChannelId = await getSetting(database, guild.id, `logging.${category}ChannelId`, null);
    if (categoryChannelId) {
      const channel = guild.channels.cache.get(categoryChannelId);
      if (channel && channel.isTextBased()) return channel;
    }

    const byName = guild.channels.cache.find(
      (ch) => ch.name === `${category}-logs` && ch.isTextBased(),
    );
    if (byName) return byName;
  }

  const channelId = await getSetting(database, guild.id, 'logging.channelId', null);
  if (channelId) {
    const channel = guild.channels.cache.get(channelId);
    if (channel && channel.isTextBased()) return channel;
  }

  return (
    guild.channels.cache.find((ch) => ch.name === process.env.LOGS_CHANNEL_NAME && ch.isTextBased())
    || guild.channels.cache.find((ch) => ch.name === 'default-logs' && ch.isTextBased())
    || null
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
