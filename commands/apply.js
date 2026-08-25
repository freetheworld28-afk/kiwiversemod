'use strict';

const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  MessageFlags,
  ChannelType,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');
const applicationService = require('../services/applicationService');

function buildEasyPanel() {
  const embed = new EmbedBuilder()
    .setColor(0x8b5cf6)
    .setTitle('📝 KiwiVerse Application Manager')
    .setDescription('Manage applications without remembering form IDs or lots of commands. Use the buttons below.')
    .addFields(
      { name: 'Quick panels', value: 'Post a **Staff** or **Game Tester** application panel in this channel.' },
      { name: 'Custom forms', value: 'Create your own application form with custom questions.' },
      { name: 'Review', value: 'Open recent applications and act on them.' },
    );

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('apply_easy_post:staff').setLabel('Post Staff Panel').setEmoji('🛡️').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('apply_easy_post:game-tester').setLabel('Post Tester Panel').setEmoji('🎮').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('apply_easy_create').setLabel('Create Custom Form').setEmoji('➕').setStyle(ButtonStyle.Success),
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('apply_easy_forms').setLabel('View Forms').setEmoji('📚').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('apply_easy_list').setLabel('Review Applications').setEmoji('📋').setStyle(ButtonStyle.Secondary),
  );

  return { embeds: [embed], components: [row1, row2] };
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('apply')
    .setDescription('KiwiVerse application system')
    .addSubcommand((sub) => sub.setName('setup').setDescription('Open the easy application manager'))
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

    if (subcommand === 'setup') {
      if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
        return interaction.reply({ content: '⛔ You need Manage Server to open the application manager.', flags: MessageFlags.Ephemeral });
      }
      return interaction.reply({ ...buildEasyPanel(), flags: MessageFlags.Ephemeral });
    }

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

  buildEasyPanel,
};
