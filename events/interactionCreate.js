const { Events, MessageFlags } = require('discord.js');
const ticketService = require('../services/ticketService');

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
