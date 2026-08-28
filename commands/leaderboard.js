'use strict';

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const levelingService = require('../services/levelingService');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('leaderboard')
    .setDescription('Show the KiwiVerse XP leaderboard'),

  async execute(interaction, client, database) {
    // Cache-aware: overlays every currently-cached user's live XP on top of
    // a SQLite candidate pool, so a member who just earned XP shows up
    // correctly even before their row is flushed.
    const rows = await levelingService.getLeaderboard(database, 10);

    const lines = rows.length
      ? rows.map((row, index) => {
          const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : `**#${index + 1}**`;
          return `${medal} <@${row.discordId}> — Level **${row.level || 0}** • **${(row.xp || 0).toLocaleString()} XP**`;
        }).join('\n')
      : 'No XP has been earned yet.';

    const embed = new EmbedBuilder()
      .setColor(0x8b5cf6)
      .setTitle('🏆 KiwiVerse Level Leaderboard')
      .setDescription(lines)
      .setFooter({ text: 'XP is earned by chatting normally in the server.' })
      .setTimestamp();

    return interaction.reply({ embeds: [embed] });
  },
};
