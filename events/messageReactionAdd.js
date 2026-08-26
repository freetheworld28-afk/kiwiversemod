'use strict';

const { Events } = require('discord.js');

module.exports = {
  name: Events.MessageReactionAdd,
  async execute(reaction, user, client, database, cache) {
    try {
      if (reaction.partial) reaction = await reaction.fetch().catch(() => null);
      if (!reaction) return;
      if (user.partial) user = await user.fetch().catch(() => null);
      if (!user || user.bot) return;
      if (!reaction.message.guild) return;

      for (const feature of client.features.values()) {
        if (feature.onReactionAdd) {
          try {
            await feature.onReactionAdd(reaction, user, client, database, cache);
          } catch (error) {
            console.error(`Error in feature ${feature.name} (reactionAdd):`, error);
          }
        }
      }
    } catch (error) {
      console.error('Error in messageReactionAdd:', error);
    }
  },
};
