'use strict';

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const inviteTracker = require('../services/inviteTrackerService');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('invites')
    .setDescription('View invite statistics')
    .addUserOption((opt) => opt.setName('user').setDescription('User to view')),

  async execute(interaction, client, database) {
    const user = interaction.options.getUser('user') || interaction.user;
    const stats = await inviteTracker.getStats(database, interaction.guild.id, user.id);

    const embed = new EmbedBuilder()
      .setColor(0x8b5cf6)
      .setTitle(`🔗 Invite Stats — ${user.username}`)
      .setThumbnail(user.displayAvatarURL({ size: 256 }))
      .addFields(
        { name: '✅ Valid', value: String(stats.valid), inline: true },
        { name: '⚠️ Suspicious', value: String(stats.suspicious), inline: true },
        { name: '🤖 Bots', value: String(stats.bots), inline: true },
        { name: '🚪 Left early', value: String(stats.leftEarly), inline: true },
        { name: '📊 Total tracked', value: String(stats.total), inline: true },
      )
      .setFooter({ text: `Suspicious = account younger than ${inviteTracker.minAccountAgeDays()} days. Left early = left within ${inviteTracker.minStayMinutes()} minutes.` })
      .setTimestamp();

    return interaction.reply({ embeds: [embed] });
  },
};
