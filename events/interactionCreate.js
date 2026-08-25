const { Events, MessageFlags, PermissionFlagsBits } = require('discord.js');
const ticketService = require('../services/ticketService');
const applicationService = require('../services/applicationService');
const inviteTracker = require('../services/inviteTrackerService');
const inviteEventCommand = require('../commands/inviteevent');

module.exports = {
  name: Events.InteractionCreate,
  async execute(interaction, client, database, cache) {
    try {
      if (interaction.isChatInputCommand()) {
        const command = client.commands.get(interaction.commandName);
        if (!command) return;
        await command.execute(interaction, client, database, cache);
        return;
      }

      if (interaction.isStringSelectMenu() && interaction.customId === 'ticket_category') {
        const category = interaction.values[0];
        await interaction.showModal(ticketService.buildReasonModal(category));
        return;
      }

      if (interaction.isModalSubmit() && interaction.customId.startsWith('ticket_create:')) {
        const category = interaction.customId.split(':')[1];
        const reason = interaction.fields.getTextInputValue('reason');
        await ticketService.createTicket(interaction, database, category, reason);
        return;
      }

      if (interaction.isButton() && interaction.customId.startsWith('ticket_')) {
        await ticketService.handleButton(interaction, database);
        return;
      }

      if (interaction.isButton() && (interaction.customId === 'apply_start' || interaction.customId.startsWith('apply_start:'))) {
        const slug = interaction.customId.includes(':') ? interaction.customId.split(':')[1] : 'staff';
        await applicationService.startApplication(interaction, database, slug);
        return;
      }

      if (interaction.isButton() && interaction.customId === 'apply_status') {
        await applicationService.showStatus(interaction, database);
        return;
      }

      if (interaction.isButton() && interaction.customId === 'apply_easy_create') {
        if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
          return interaction.reply({ content: '⛔ You need Manage Server to create forms.', ephemeral: true });
        }
        await interaction.showModal(applicationService.buildFormCreatorModal(''));
        return;
      }

      if (interaction.isButton() && interaction.customId === 'apply_easy_forms') {
        await applicationService.showForms(interaction, database);
        return;
      }

      if (interaction.isButton() && interaction.customId === 'apply_easy_list') {
        await applicationService.listApplications(interaction, database);
        return;
      }

      if (interaction.isButton() && interaction.customId.startsWith('apply_easy_post:')) {
        if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
          return interaction.reply({ content: '⛔ You need Manage Server to post application panels.', ephemeral: true });
        }
        const slug = interaction.customId.split(':')[1];
        const form = await applicationService.getForm(database, interaction.guild.id, slug);
        if (!form) return interaction.reply({ content: `Application form \`${slug}\` was not found.`, ephemeral: true });
        await interaction.channel.send(applicationService.buildPanel(form));
        await interaction.reply({ content: `✅ **${form.name}** panel posted here.`, ephemeral: true });
        return;
      }

      if (interaction.isModalSubmit() && (interaction.customId === 'apply_submit' || interaction.customId.startsWith('apply_submit:'))) {
        const slug = interaction.customId.includes(':') ? interaction.customId.split(':')[1] : 'staff';
        await applicationService.submitApplication(interaction, database, slug);
        return;
      }

      if (interaction.isModalSubmit() && interaction.customId.startsWith('apply_form_create:')) {
        const reviewChannelId = interaction.customId.split(':')[1] || '';
        await applicationService.createForm(interaction, database, reviewChannelId);
        return;
      }

      if (interaction.isButton() && /^(apply_accept|apply_reject|apply_interview):\d+$/.test(interaction.customId)) {
        await applicationService.handleDecision(interaction, database);
        return;
      }

      if (interaction.isButton() && interaction.customId === 'inviteevent_easy_start') {
        if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
          return interaction.reply({ content: '⛔ You need Manage Server to start invite events.', ephemeral: true });
        }
        await interaction.showModal(inviteEventCommand.buildStartModal());
        return;
      }

      if (interaction.isButton() && interaction.customId === 'inviteevent_easy_status') {
        await inviteEventCommand.sendStatus(interaction, database, true);
        return;
      }

      if (interaction.isButton() && interaction.customId === 'inviteevent_easy_leaderboard') {
        await inviteEventCommand.sendLeaderboard(interaction, database, true);
        return;
      }

      if (interaction.isButton() && interaction.customId === 'inviteevent_easy_end') {
        await inviteEventCommand.endCurrentEvent(interaction, database, true);
        return;
      }

      if (interaction.isModalSubmit() && interaction.customId === 'inviteevent_easy_start_submit') {
        if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
          return interaction.reply({ content: '⛔ You need Manage Server to start invite events.', ephemeral: true });
        }
        const name = interaction.fields.getTextInputValue('event_name').trim();
        const result = await inviteTracker.startEvent(database, interaction.guild.id, name, interaction.user.id);
        if (result.error) return interaction.reply({ content: `⚠️ ${result.error}`, ephemeral: true });
        await interaction.reply({ content: `🎉 Invite event **${result.name}** is now live. Only valid invites count.`, ephemeral: true });
        return;
      }
    } catch (error) {
      console.error(`Interaction error (${interaction.customId || interaction.commandName || 'unknown'}):`, error);
      const payload = {
        content: '⚠️ An error occurred while processing that interaction.',
        flags: MessageFlags.Ephemeral,
      };
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp(payload).catch(() => null);
      } else {
        await interaction.reply(payload).catch(() => null);
      }
    }
  },
};
