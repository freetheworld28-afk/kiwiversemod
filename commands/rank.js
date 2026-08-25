'use strict';

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

function xpForLevel(level) {
  return Math.pow(level * 10, 2);
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('rank')
    .setDescription('Show your or another member’s KiwiVerse level and XP')
    .addUserOption((opt) => opt.setName('user').setDescription('Member to view')),

  async execute(interaction, client, database) {
    const target = interaction.options.getUser('user') || interaction.user;
    const db = await database;
    const row = await db.get('SELECT xp, level FROM users WHERE discord_id = ?', target.id);

    const xp = row?.xp || 0;
    const level = row?.level || 0;
    const currentFloor = xpForLevel(level);
    const nextFloor = xpForLevel(level + 1);
    const progress = Math.max(0, xp - currentFloor);
    const needed = Math.max(1, nextFloor - currentFloor);
    const percent = Math.min(100, Math.floor((progress / needed) * 100));
    const filled = Math.round(percent / 10);
    const bar = `${'█'.repeat(filled)}${'░'.repeat(10 - filled)}`;

    const positionRow = await db.get(
      'SELECT COUNT(*) + 1 AS rank FROM users WHERE xp > ?',
      xp,
    );

    const embed = new EmbedBuilder()
      .setColor(0x8b5cf6)
      .setAuthor({ name: `${target.username}'s Rank`, iconURL: target.displayAvatarURL({ size: 128 }) })
      .addFields(
        { name: '🏆 Rank', value: `#${positionRow?.rank || 1}`, inline: true },
        { name: '⭐ Level', value: String(level), inline: true },
        { name: '✨ Total XP', value: xp.toLocaleString(), inline: true },
        { name: 'Progress', value: `\`${bar}\` ${percent}%\n${progress.toLocaleString()} / ${needed.toLocaleString()} XP to next level` },
      )
      .setTimestamp();

    return interaction.reply({ embeds: [embed] });
  },
};
