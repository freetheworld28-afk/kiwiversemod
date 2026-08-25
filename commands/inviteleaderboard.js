'use strict';

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const inviteTracker = require('../services/inviteTrackerService');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('inviteleaderboard')
    .setDescription('Show the server invite leaderboard'),

  async execute(interaction, client, database) {
    const rows = await inviteTracker.getLeaderboard(database, interaction.guild.id, null, 10);
    const lines = rows.length
      ? rows.map((row, index) => {
          const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : `**#${index + 1}**`;
          return `${medal} <@${row.inviterId}> — **${row.valid || 0} valid** • ${row.suspicious || 0} suspicious • ${row.bots || 0} bots • ${row.leftEarly || 0} left early`;
        }).join('\n')
      : 'No invite activity has been tracked yet.';

    const embed = new EmbedBuilder()
      .setColor(0x8b5cf6)
      .setTitle('🏆 KiwiVerse Invite Leaderboard')
      .setDescription(lines)
      .setFooter({ text: 'Only valid invites count toward ranking.' })
      .setTimestamp();

    return interaction.reply({ embeds: [embed] });
  },
};
