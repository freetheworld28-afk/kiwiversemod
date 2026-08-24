const { Events } = require('discord.js');

module.exports = {
  name: Events.MessageCreate,
  async execute(message, client, database, cache) {
    if (message.author.bot || !message.guild) return;

    // Run message-based features
    for (const feature of client.features.values()) {
      if (feature.onMessage) {
        try {
          await feature.onMessage(message, client, database, cache);
        } catch (error) {
          console.error(`Error in feature ${feature.name}:`, error);
        }
      }
    }
  },
};

