'use strict';

const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const inviteTracker = require('../services/inviteTrackerService');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('inviteevent')
    .setDescription('Manage KiwiVerse invite events')
    .addSubcommand((sub) => sub
      .setName('start')
      .setDescription('Start an invite event')
      .addStringOption((opt) => opt.setName('name').setDescription('Event name').setRequired(true).setMaxLength(80)))
    .addSubcommand((sub) => sub.setName('status').setDescription('View the active invite event'))
    .addSubcommand((sub) => sub.setName('leaderboard').setDescription('View the active event leaderboard'))
    .addSubcommand((sub) => sub.setName('end').setDescription('End the active invite event')),

  async execute(interaction, client, database) {
    const sub = interaction.options.getSubcommand();
    const isManager = interaction.member.permissions.has(PermissionFlagsBits.ManageGuild);

    if (sub === 'start') {
      if (!isManager) return interaction.reply({ content: '⛔ You need Manage Server to start invite events.', flags: MessageFlags.Ephemeral });
      const result = await inviteTracker.startEvent(database, interaction.guild.id, interaction.options.getString('name'), interaction.user.id);
      if (result.error) return interaction.reply({ content: `⚠️ ${result.error}`, flags: MessageFlags.Ephemeral });
      return interaction.reply({ content: `🎉 Invite event **${result.name}** started. Only valid invites will count.` });
    }

    const db = await database;
    const event = await inviteTracker.activeEvent(db, interaction.guild.id);
    if (!event) return interaction.reply({ content: 'There is no active invite event.', flags: MessageFlags.Ephemeral });

    if (sub === 'status') {
      return interaction.reply({
        embeds: [new EmbedBuilder()
          .setColor(0x8b5cf6)
          .setTitle(`🎉 ${event.name}`)
          .setDescription(`Invite event #${event.id} is active.\nStarted <t:${Math.floor(new Date(event.started_at).getTime() / 1000)}:R>.`)
          .setFooter({ text: 'Use /inviteevent leaderboard to view standings.' })],
      });
    }

    if (sub === 'leaderboard') {
      const rows = await inviteTracker.getLeaderboard(database, interaction.guild.id, event.id, 10);
      const lines = rows.length
        ? rows.map((row, index) => `${index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : `**#${index + 1}**`} <@${row.inviterId}> — **${row.valid || 0} valid**`).join('\n')
        : 'Nobody has earned a valid invite in this event yet.';
      return interaction.reply({ embeds: [new EmbedBuilder().setColor(0x8b5cf6).setTitle(`🏆 ${event.name} Leaderboard`).setDescription(lines).setFooter({ text: 'Bots, suspicious accounts, and early leaves do not count.' }).setTimestamp()] });
    }

    if (sub === 'end') {
      if (!isManager) return interaction.reply({ content: '⛔ You need Manage Server to end invite events.', flags: MessageFlags.Ephemeral });
      const rows = await inviteTracker.getLeaderboard(database, interaction.guild.id, event.id, 10);
      await inviteTracker.endEvent(database, interaction.guild.id);
      const winner = rows[0];
      return interaction.reply({
        content: winner
          ? `🏁 **${event.name}** ended! Winner: <@${winner.inviterId}> with **${winner.valid || 0} valid invites**.`
          : `🏁 **${event.name}** ended. No valid invites were recorded.`,
      });
    }
  },
};
