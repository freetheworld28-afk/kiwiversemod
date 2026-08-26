'use strict';

const { EmbedBuilder } = require('discord.js');
const { getSetting } = require('../services/settingsService');

function emojiMatches(reactionEmoji, configuredEmoji) {
  if (!configuredEmoji) return false;
  if (reactionEmoji.id) {
    return reactionEmoji.id === configuredEmoji || `<:${reactionEmoji.name}:${reactionEmoji.id}>` === configuredEmoji;
  }
  return reactionEmoji.name === configuredEmoji;
}

async function syncStarboardEntry(reaction, user, client, database) {
  let message = reaction.message;
  const guild = message.guild;
  if (!guild) return;

  const enabled = await getSetting(database, guild.id, 'starboard.enabled', false);
  if (!enabled) return;

  const configuredEmoji = await getSetting(database, guild.id, 'starboard.emoji', '⭐');
  if (!emojiMatches(reaction.emoji, configuredEmoji)) return;

  const channelId = await getSetting(database, guild.id, 'starboard.channelId', null);
  if (!channelId) return;
  const starboardChannel = guild.channels.cache.get(channelId);
  if (!starboardChannel?.isTextBased()) return;

  if (message.partial) message = await message.fetch().catch(() => null);
  if (!message) return;
  if (message.author?.bot) return;
  if (message.channel.id === starboardChannel.id) return;

  const requiredStars = Number(await getSetting(database, guild.id, 'starboard.requiredStars', 3)) || 3;
  const db = await database;

  const liveReaction = message.reactions.cache.get(reaction.emoji.id || reaction.emoji.name);
  const stars = liveReaction?.count || 0;

  const existing = await db.get('SELECT * FROM starboard WHERE original_message_id = ?', message.id);

  if (stars < requiredStars) {
    if (existing) {
      const starMsg = await starboardChannel.messages.fetch(existing.starboard_message_id).catch(() => null);
      await starMsg?.delete().catch(() => null);
      await db.run('DELETE FROM starboard WHERE original_message_id = ?', message.id);
    }
    return;
  }

  const embed = new EmbedBuilder()
    .setColor(0xf1c40f)
    .setAuthor({ name: message.author?.tag || 'Unknown user', iconURL: message.author?.displayAvatarURL?.() })
    .setDescription(message.content ? message.content.slice(0, 4000) : '*No text content*')
    .addFields({ name: 'Source', value: `[Jump to message](${message.url})` })
    .setFooter({ text: `Message ID: ${message.id}` })
    .setTimestamp(message.createdAt);

  const image = message.attachments.find((a) => a.contentType?.startsWith('image/'));
  if (image) embed.setImage(image.url);

  const content = `${configuredEmoji} **${stars}** ${message.channel}`;

  if (existing) {
    const starMsg = await starboardChannel.messages.fetch(existing.starboard_message_id).catch(() => null);
    if (starMsg) {
      await starMsg.edit({ content, embeds: [embed] }).catch(() => null);
      await db.run('UPDATE starboard SET stars = ? WHERE original_message_id = ?', stars, message.id);
      return;
    }
  }

  const posted = await starboardChannel.send({ content, embeds: [embed] }).catch(() => null);
  if (!posted) return;

  await db.run(
    `INSERT INTO starboard (original_message_id, starboard_message_id, channel_id, author_id, stars)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(original_message_id) DO UPDATE SET starboard_message_id = excluded.starboard_message_id, stars = excluded.stars`,
    message.id,
    posted.id,
    message.channel.id,
    message.author?.id || null,
    stars,
  );
}

module.exports = {
  name: 'starboard',
  onReactionAdd: syncStarboardEntry,
  onReactionRemove: syncStarboardEntry,
};
