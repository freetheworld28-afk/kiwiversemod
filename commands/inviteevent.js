'use strict';

const {
  SlashCommandBuilder,
  EmbedBuilder,
  PermissionFlagsBits,
  MessageFlags,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const inviteTracker = require('../services/inviteTrackerService');

function buildControlPanel() {
  const embed = new EmbedBuilder()
    .setColor(0x8b5cf6)
    .setTitle('🎉 KiwiVerse Invite Event Manager')
    .setDescription('Start, check, and end invite events with buttons. Only valid invites count toward event standings.')
    .addFields(
      { name: 'Valid invites', value: 'Normal human accounts that pass anti-abuse checks.' },
      { name: 'Not counted', value: 'Bots, suspicious/new accounts, and members who leave too quickly.' },
    );

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('inviteevent_easy_start').setLabel('Start Event').setEmoji('🚀').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('inviteevent_easy_status').setLabel('Status').setEmoji('📊').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('inviteevent_easy_leaderboard').setLabel('Leaderboard').setEmoji('🏆').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('inviteevent_easy_end').setLabel('End Event').setEmoji('🏁').setStyle(ButtonStyle.Danger),
  );

  return { embeds: [embed], components: [row] };
}

function buildStartModal() {
  const modal = new ModalBuilder().setCustomId('inviteevent_easy_start_submit').setTitle('Start Invite Event');
  const name = new TextInputBuilder()
    .setCustomId('event_name')
    .setLabel('Event name')
    .setPlaceholder('Example: 250 Member Race')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(80);
  modal.addComponents(new ActionRowBuilder().addComponents(name));
  return modal;
}

async function sendStatus(interaction, database, ephemeral = true) {
  const db = await database;
  const event = await inviteTracker.activeEvent(db, interaction.guild.id);
  if (!event) return interaction.reply({ content: 'There is no active invite event.', ephemeral });
  return interaction.reply({
    embeds: [new EmbedBuilder()
      .setColor(0x8b5cf6)
      .setTitle(`🎉 ${event.name}`)
      .setDescription(`Invite event #${event.id} is active.\nStarted <t:${Math.floor(new Date(event.started_at).getTime() / 1000)}:R>.`)
      .setFooter({ text: 'Use Leaderboard to view standings.' })],
    ephemeral,
  });
}

async function sendLeaderboard(interaction, database, ephemeral = false) {
  const db = await database;
  const event = await inviteTracker.activeEvent(db, interaction.guild.id);
  if (!event) return interaction.reply({ content: 'There is no active invite event.', ephemeral: true });
  const rows = await inviteTracker.getLeaderboard(database, interaction.guild.id, event.id, 10);
  const lines = rows.length
    ? rows.map((row, index) => `${index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : `**#${index + 1}**`} <@${row.inviterId}> — **${row.valid || 0} valid**`).join('\n')
    : 'Nobody has earned a valid invite in this event yet.';
  return interaction.reply({ embeds: [new EmbedBuilder().setColor(0x8b5cf6).setTitle(`🏆 ${event.name} Leaderboard`).setDescription(lines).setFooter({ text: 'Bots, suspicious accounts, and early leaves do not count.' }).setTimestamp()], ephemeral });
}

async function endCurrentEvent(interaction, database, ephemeral = false) {
  if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
    return interaction.reply({ content: '⛔ You need Manage Server to end invite events.', ephemeral: true });
  }
  const db = await database;
  const event = await inviteTracker.activeEvent(db, interaction.guild.id);
  if (!event) return interaction.reply({ content: 'There is no active invite event.', ephemeral: true });
  const rows = await inviteTracker.getLeaderboard(database, interaction.guild.id, event.id, 10);
  await inviteTracker.endEvent(database, interaction.guild.id);
  const winner = rows[0];
  return interaction.reply({
    content: winner
      ? `🏁 **${event.name}** ended! Winner: <@${winner.inviterId}> with **${winner.valid || 0} valid invites**.`
      : `🏁 **${event.name}** ended. No valid invites were recorded.`,
    ephemeral,
  });
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('inviteevent')
    .setDescription('Manage KiwiVerse invite events')
    .addSubcommand((sub) => sub.setName('setup').setDescription('Open the easy invite event manager'))
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

    if (sub === 'setup') {
      if (!isManager) return interaction.reply({ content: '⛔ You need Manage Server to open the invite event manager.', flags: MessageFlags.Ephemeral });
      return interaction.reply({ ...buildControlPanel(), flags: MessageFlags.Ephemeral });
    }

    if (sub === 'start') {
      if (!isManager) return interaction.reply({ content: '⛔ You need Manage Server to start invite events.', flags: MessageFlags.Ephemeral });
      const result = await inviteTracker.startEvent(database, interaction.guild.id, interaction.options.getString('name'), interaction.user.id);
      if (result.error) return interaction.reply({ content: `⚠️ ${result.error}`, flags: MessageFlags.Ephemeral });
      return interaction.reply({ content: `🎉 Invite event **${result.name}** started. Only valid invites will count.` });
    }

    if (sub === 'status') return sendStatus(interaction, database, false);
    if (sub === 'leaderboard') return sendLeaderboard(interaction, database, false);
    if (sub === 'end') return endCurrentEvent(interaction, database, false);
  },

  buildControlPanel,
  buildStartModal,
  sendStatus,
  sendLeaderboard,
  endCurrentEvent,
};
