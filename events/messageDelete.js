'use strict';

const { Events } = require('discord.js');
const { logEvent, consumeSuppressed } = require('../services/loggingService');

module.exports = {
  name: Events.MessageDelete,
  async execute(message, client, database) {
    try {
      const guild = message.guild;
      if (!guild) return;
      if (message.author?.bot) return;

      // If the content filter (or another moderation path) just deleted this
      // exact message itself, it already posted a richer, more specific log
      // entry - don't also post a generic duplicate for the gateway event
      // Discord fires for every deletion regardless of who/what caused it.
      if (consumeSuppressed(`message-delete:${message.id}`)) return;

      await logEvent(guild, database, 'messageDelete', { message });
    } catch (error) {
      console.error('[Logging] Error in messageDelete handler:', error);
    }
  },
};
