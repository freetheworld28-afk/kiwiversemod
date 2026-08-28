'use strict';

const { Events } = require('discord.js');
const { logEvent } = require('../services/loggingService');

module.exports = {
  name: Events.MessageUpdate,
  async execute(oldMessage, newMessage, client, database) {
    try {
      if (newMessage.partial) {
        newMessage = await newMessage.fetch().catch(() => newMessage);
      }

      const guild = newMessage.guild;
      if (!guild) return;
      if (newMessage.author?.bot) return;

      // Discord also fires this for embed-only updates (e.g. link unfurls) with
      // no actual content change - ignore those.
      if (!oldMessage.partial && !newMessage.partial && oldMessage.content === newMessage.content) return;

      await logEvent(guild, database, 'messageEdit', { oldMessage, newMessage });
    } catch (error) {
      console.error('[Logging] Error in messageUpdate handler:', error);
    }
  },
};
