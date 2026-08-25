'use strict';

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('leaderboard')
    .setDescription('Show the KiwiVerse XP leaderboard'),

  async execute(interaction, client, database) {
    const db = await database;
    const rows = await db.all(
      'SELECT discord_id, username, xp, level FROM users ORDER BY xp DESC LIMIT 10',
    );

    const lines = rows.length
      ? rows.map((row, index) => {
          const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : `**#${index + 1}**`;
          return `${medal} <@${row.discord_id}> — Level **${row.level || 0}** • **${(row.xp || 0).toLocaleString()} XP**`;
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
