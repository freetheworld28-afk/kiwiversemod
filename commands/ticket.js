'use strict';

const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const ticketService = require('../services/ticketService');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('ticket')
    .setDescription('KiwiVerse ticket system')
    .addSubcommand((sub) =>
      sub
        .setName('panel')
        .setDescription('Post the ticket panel in this channel'),
    )
    .addSubcommand((sub) =>
      sub
        .setName('add')
        .setDescription('Add a member to the current ticket')
        .addUserOption((opt) => opt.setName('user').setDescription('Member to add').setRequired(true)),
    )
    .addSubcommand((sub) =>
      sub
        .setName('remove')
        .setDescription('Remove a member from the current ticket')
        .addUserOption((opt) => opt.setName('user').setDescription('Member to remove').setRequired(true)),
    ),

  async execute(interaction, client, database) {
    const subcommand = interaction.options.getSubcommand();

    if (subcommand === 'panel') {
      if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
        return interaction.reply({ content: '⛔ You need Manage Server to post the ticket panel.', flags: MessageFlags.Ephemeral });
      }

      await ticketService.ensureSchema(database);
      await interaction.channel.send(ticketService.buildPanel());
      return interaction.reply({ content: '✅ Ticket panel posted.', flags: MessageFlags.Ephemeral });
    }

    const user = interaction.options.getUser('user');
    if (subcommand === 'add') return ticketService.addUser(interaction, database, user);
    if (subcommand === 'remove') return ticketService.removeUser(interaction, database, user);
  },
};
