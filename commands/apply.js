'use strict';

const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const applicationService = require('../services/applicationService');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('apply')
    .setDescription('KiwiVerse staff application system')
    .addSubcommand((sub) => sub.setName('start').setDescription('Start a staff application'))
    .addSubcommand((sub) => sub.setName('status').setDescription('View your latest application status'))
    .addSubcommand((sub) => sub.setName('panel').setDescription('Post the staff application panel'))
    .addSubcommand((sub) => sub.setName('list').setDescription('List recent applications for staff review'))
    .addSubcommand((sub) =>
      sub
        .setName('review')
        .setDescription('Open an application review card')
        .addIntegerOption((opt) => opt.setName('id').setDescription('Application ID').setRequired(true).setMinValue(1)),
    ),

  async execute(interaction, client, database) {
    const subcommand = interaction.options.getSubcommand();

    if (subcommand === 'start') return applicationService.startApplication(interaction, database);
    if (subcommand === 'status') return applicationService.showStatus(interaction, database);
    if (subcommand === 'list') return applicationService.listApplications(interaction, database);
    if (subcommand === 'review') return applicationService.reviewApplication(interaction, database, interaction.options.getInteger('id'));

    if (subcommand === 'panel') {
      if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
        return interaction.reply({ content: '⛔ You need Manage Server to post the application panel.', flags: MessageFlags.Ephemeral });
      }
      await applicationService.ensureSchema(database);
      await interaction.channel.send(applicationService.buildPanel());
      return interaction.reply({ content: '✅ Application panel posted.', flags: MessageFlags.Ephemeral });
    }
  },
};
