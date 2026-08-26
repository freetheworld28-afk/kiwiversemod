const { Events, REST, Routes, ActivityType } = require('discord.js');
const { initDashboardSchema } = require('../api/init.js');
const { startApiServer } = require('../api/server.js');
const inviteTracker = require('../services/inviteTrackerService');
const reminderService = require('../services/reminderService');

module.exports = {
  name: Events.ClientReady,
  once: true,
  async execute(_readyClient, client, database, cache) {
    console.log(`✅ KiwiVerse Bot online as ${client.user.tag}`);
    client.user.setActivity('over the KiwiVerse', { type: ActivityType.Watching });

    // Initialize bot database tables.
    const { initDatabase } = require('../index.js');
    await initDatabase();

    // Initialize dashboard configuration storage and API.
    await initDashboardSchema(database);
    startApiServer(client, database);

    // Restore persistent reminders after restarts/deploys.
    await reminderService.initialize(client, database).catch((error) => {
      console.error('Reminder scheduler init failed:', error);
    });

    // Snapshot current invite use counts so new joins can be attributed.
    for (const guild of client.guilds.cache.values()) {
      await inviteTracker.initializeGuild(guild, database).catch((error) => {
        console.error(`Invite tracker init failed for ${guild.id}:`, error);
      });
    }

    // Register slash commands. Use guild commands for fast updates and clear stale
    // global commands so Discord does not show duplicates.
    try {
      const commands = Array.from(client.commands.values()).map((cmd) => cmd.data.toJSON());
      const rest = new REST().setToken(process.env.DISCORD_TOKEN);

      if (process.env.GUILD_ID) {
        await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: [] });
        await rest.put(Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID), { body: commands });
        console.log(`✅ Registered ${commands.length} guild slash commands and cleared old global duplicates`);
      } else if (commands.length > 0) {
        await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
        console.log(`✅ Registered ${commands.length} global slash commands`);
      }
    } catch (error) {
      console.error('❌ Failed to register commands:', error);
    }
  },
};
