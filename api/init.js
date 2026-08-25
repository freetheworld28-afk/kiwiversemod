'use strict';

const { ensureGuildDefaults } = require('../services/settingsService');

async function initDashboardSchema(database) {
  const db = await database;
  await db.exec(`
    CREATE TABLE IF NOT EXISTS guild_settings (
      guild_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (guild_id, key)
    );

    CREATE INDEX IF NOT EXISTS idx_guild_settings_guild
      ON guild_settings(guild_id);
  `);

  if (process.env.GUILD_ID) {
    await ensureGuildDefaults(database, process.env.GUILD_ID);
  }
}

module.exports = { initDashboardSchema };
