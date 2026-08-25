'use strict';

const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags, ChannelType } = require('discord.js');
const applicationService = require('../services/applicationService');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('apply')
    .setDescription('KiwiVerse application system')
    .addSubcommand((sub) => sub
      .setName('start')
      .setDescription('Start an application')
      .addStringOption((opt) => opt.setName('form').setDescription('Application form ID, e.g. staff or game-tester')))
    .addSubcommand((sub) => sub.setName('status').setDescription('View your latest application status'))
    .addSubcommand((sub) => sub
      .setName('panel')
      .setDescription('Post an application panel')
      .addStringOption((opt) => opt.setName('form').setDescription('Application form ID').setRequired(true)))
    .addSubcommand((sub) => sub.setName('forms').setDescription('List available application forms'))
    .addSubcommand((sub) => sub
      .setName('create')
      .setDescription('Create or update a custom application form')
      .addChannelOption((opt) => opt.setName('review_channel').setDescription('Private channel where applications are reviewed').addChannelTypes(ChannelType.GuildText)))
    .addSubcommand((sub) => sub
      .setName('delete')
      .setDescription('Delete a custom application form')
      .addStringOption((opt) => opt.setName('form').setDescription('Application form ID').setRequired(true)))
    .addSubcommand((sub) => sub.setName('list').setDescription('List recent applications for staff review'))
    .addSubcommand((sub) => sub
      .setName('review')
      .setDescription('Open an application review card')
      .addIntegerOption((opt) => opt.setName('id').setDescription('Application ID').setRequired(true).setMinValue(1))),

  async execute(interaction, client, database) {
    const subcommand = interaction.options.getSubcommand();

    if (subcommand === 'start') return applicationService.startApplication(interaction, database, interaction.options.getString('form') || 'staff');
    if (subcommand === 'status') return applicationService.showStatus(interaction, database);
    if (subcommand === 'forms') return applicationService.showForms(interaction, database);
    if (subcommand === 'list') return applicationService.listApplications(interaction, database);
    if (subcommand === 'review') return applicationService.reviewApplication(interaction, database, interaction.options.getInteger('id'));
    if (subcommand === 'delete') return applicationService.deleteForm(interaction, database, interaction.options.getString('form'));

    if (subcommand === 'create') {
      if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
        return interaction.reply({ content: '⛔ You need Manage Server to create application forms.', flags: MessageFlags.Ephemeral });
      }
      const reviewChannel = interaction.options.getChannel('review_channel');
      return interaction.showModal(applicationService.buildFormCreatorModal(reviewChannel?.id || ''));
    }

    if (subcommand === 'panel') {
      if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
        return interaction.reply({ content: '⛔ You need Manage Server to post application panels.', flags: MessageFlags.Ephemeral });
      }
      const slug = interaction.options.getString('form');
      const form = await applicationService.getForm(database, interaction.guild.id, slug);
      if (!form) return interaction.reply({ content: `Application form \`${slug}\` was not found. Use \`/apply forms\`.`, flags: MessageFlags.Ephemeral });
      await interaction.channel.send(applicationService.buildPanel(form));
      return interaction.reply({ content: `✅ **${form.name}** application panel posted.`, flags: MessageFlags.Ephemeral });
    }
  },
};
