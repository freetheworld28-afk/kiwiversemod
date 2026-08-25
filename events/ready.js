const { Events, REST, Routes, ActivityType } = require('discord.js');
const { initDashboardSchema } = require('../api/init.js');
const { startApiServer } = require('../api/server.js');

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

    // Register slash commands.
    try {
      const commands = Array.from(client.commands.values()).map((cmd) => cmd.data.toJSON());

      if (commands.length > 0) {
        const rest = new REST().setToken(process.env.DISCORD_TOKEN);

        if (process.env.GUILD_ID) {
          // Use fast guild-scoped commands for KiwiVerse. Clear any old global
          // registrations first so Discord does not show duplicate slash commands.
          await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: [] });
          await rest.put(
            Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
            { body: commands },
          );
          console.log(`✅ Registered ${commands.length} guild slash commands and cleared old global duplicates`);
        } else {
          await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
          console.log(`✅ Registered ${commands.length} global slash commands`);
        }
      }
    } catch (error) {
      console.error('❌ Failed to register commands:', error);
    }
  },
};
