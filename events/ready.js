const { Events, REST, Routes, ActivityType } = require('discord.js');

module.exports = {
  name: Events.ClientReady,
  once: true,
  async execute(client, database, cache) {
    console.log(`✅ KiwiVerse Bot online as ${client.user.tag}`);
    client.user.setActivity('over the KiwiVerse', { type: ActivityType.Watching });

    // Initialize database
    const { initDatabase } = require('../index.js');
    await initDatabase();

    // Register slash commands
    try {
      const commands = Array.from(client.commands.values()).map((cmd) => cmd.data.toJSON());

      if (commands.length > 0) {
        const rest = new REST().setToken(process.env.DISCORD_TOKEN);
        const route = process.env.GUILD_ID
          ? Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID)
          : Routes.applicationCommands(process.env.CLIENT_ID);

        await rest.put(route, { body: commands });
        console.log(`✅ Registered ${commands.length} slash commands`);
      }
    } catch (error) {
      console.error('❌ Failed to register commands:', error);
    }
  },
};

