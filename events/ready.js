const { Events, REST, Routes, ActivityType } = require('discord.js');
const { initDashboardSchema } = require('../api/init.js');
const { startApiServer } = require('../api/server.js');
const inviteTracker = require('../services/inviteTrackerService');
const reminderService = require('../services/reminderService');
const giveawayService = require('../services/giveawayService');
const levelingService = require('../services/levelingService');

module.exports = {
  name: Events.ClientReady,
  once: true,
  async execute(_readyClient, client, database, cache) {
    console.log(`✅ KiwiVerse Bot online as ${client.user.tag}`);
    client.user.setActivity('over the KiwiVerse', { type: ActivityType.Watching });

    // Database init is foundational - almost everything else depends on it,
    // so a failure here is fatal. Fail loudly and exit rather than limping
    // forward into a half-initialized state or crashing later via an
    // unhandled rejection with no context.
    try {
      const { initDatabase } = require('../index.js');
      await initDatabase();
      await initDashboardSchema(database);
    } catch (error) {
      console.error('❌ [Startup] Database initialization failed - the bot cannot safely continue:', error);
      process.exit(1);
    }

    try {
      startApiServer(client, database);
    } catch (error) {
      console.error('❌ [Dashboard] API server failed to start (bot continues without it):', error);
    }

    // Restore persistent reminders after restarts/deploys.
    await reminderService.initialize(client, database).catch((error) => {
      console.error('[Reminders] Scheduler init failed:', error);
    });

    // Resume any giveaways still running (schedules their end, or ends them
    // immediately if their timer already elapsed while the bot was offline).
    await giveawayService.initialize(client, database).catch((error) => {
      console.error('[Giveaways] Scheduler init failed:', error);
    });

    // Start batching leveling XP writes instead of hitting SQLite per message.
    levelingService.startAutoFlush(database);

    // Snapshot current invite use counts so new joins can be attributed.
    for (const guild of client.guilds.cache.values()) {
      await inviteTracker.initializeGuild(guild, database).catch((error) => {
        console.error(`[Invites] Tracker init failed for guild ${guild.id}:`, error);
      });
    }

    // Register slash commands. Use guild commands for fast updates and clear
    // stale global commands so Discord does not show duplicates. Each
    // command is serialized individually so one malformed definition can't
    // block registration for every other command.
    try {
      const commands = [];
      for (const command of client.commands.values()) {
        try {
          commands.push(command.data.toJSON());
        } catch (error) {
          console.error(`❌ [Commands] Skipping "${command.data?.name || 'unknown'}" - invalid definition:`, error);
        }
      }

      const rest = new REST().setToken(process.env.DISCORD_TOKEN);

      if (process.env.GUILD_ID) {
        await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: [] });
        await rest.put(Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID), { body: commands });
        console.log(`✅ [Commands] Registered ${commands.length} guild slash commands and cleared old global duplicates`);
      } else if (commands.length > 0) {
        await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
        console.log(`✅ [Commands] Registered ${commands.length} global slash commands`);
      }
    } catch (error) {
      console.error('❌ [Commands] Failed to register commands (bot continues running with previously-registered commands, if any):', error);
    }
  },
};
