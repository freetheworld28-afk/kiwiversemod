'use strict';

const { Events } = require('discord.js');

module.exports = {
  name: Events.MessageReactionRemove,
  async execute(reaction, user, client, database, cache) {
    try {
      if (reaction.partial) reaction = await reaction.fetch().catch(() => null);
      if (!reaction) return;
      if (user.partial) user = await user.fetch().catch(() => null);
      if (!user || user.bot) return;
      if (!reaction.message.guild) return;

      for (const feature of client.features.values()) {
        if (feature.onReactionRemove) {
          try {
            await feature.onReactionRemove(reaction, user, client, database, cache);
          } catch (error) {
            console.error(`Error in feature ${feature.name} (reactionRemove):`, error);
          }
        }
      }
    } catch (error) {
      console.error('Error in messageReactionRemove:', error);
    }
  },
};
