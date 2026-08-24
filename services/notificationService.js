'use strict';

const { EmbedBuilder } = require('discord.js');

/**
 * Best-effort member notification helper.
 * Discord does not allow bots to bypass a user's DM/privacy settings, so every
 * notification returns a delivery result that callers can log accurately.
 */
async function notifyUser(user, options = {}) {
  const {
    title = 'KiwiVerse notification',
    description = '',
    color = 0x5865f2,
    fields = [],
    footer = 'KiwiVerse',
    files = [],
  } = options;

  if (!user) return { delivered: false, error: 'User was not provided.' };

  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(title)
    .setDescription(description || null)
    .setTimestamp();

  if (fields.length) embed.addFields(fields);
  if (footer) embed.setFooter({ text: footer });

  try {
    await user.send({ embeds: [embed], files });
    return { delivered: true, error: null };
  } catch (error) {
    console.warn(`[DM] Could not notify ${user.tag || user.id}: ${error.message}`);
    return { delivered: false, error: error.message };
  }
}

module.exports = { notifyUser };
