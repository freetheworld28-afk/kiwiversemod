'use strict';

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const levelingService = require('../services/levelingService');

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

    // Cache first, SQLite fallback for anyone not currently active - never
    // writes, so /rank can't itself dirty the leveling cache.
    const record = await levelingService.getCurrentUser(database, interaction.guild.id, target.id, target.username);
    const xp = record.xp;
    const level = record.level;

    const currentFloor = xpForLevel(level);
    const nextFloor = xpForLevel(level + 1);
    const progress = Math.max(0, xp - currentFloor);
    const needed = Math.max(1, nextFloor - currentFloor);
    const percent = Math.min(100, Math.floor((progress / needed) * 100));
    const filled = Math.round(percent / 10);
    const bar = `${'█'.repeat(filled)}${'░'.repeat(10 - filled)}`;

    const rank = await levelingService.getEffectiveRank(database, target.id, xp);

    const embed = new EmbedBuilder()
      .setColor(0x8b5cf6)
      .setAuthor({ name: `${target.username}'s Rank`, iconURL: target.displayAvatarURL({ size: 128 }) })
      .addFields(
        { name: '🏆 Rank', value: `#${rank}`, inline: true },
        { name: '⭐ Level', value: String(level), inline: true },
        { name: '✨ Total XP', value: xp.toLocaleString(), inline: true },
        { name: 'Progress', value: `\`${bar}\` ${percent}%\n${progress.toLocaleString()} / ${needed.toLocaleString()} XP to next level` },
      )
      .setTimestamp();

    return interaction.reply({ embeds: [embed] });
  },
};
