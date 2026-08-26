'use strict';

async function ensureSchema(database) {
  const db = await database;
  await db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_reaction_roles_unique
    ON reaction_roles(guild_id, message_id, emoji);`);
}

// Custom emoji come back from the reaction option as <:name:id> or
// <a:name:id> - key on the snowflake ID so renames don't break the binding.
// Unicode emoji are used as-is, matching MessageReaction#emoji.name at runtime.
function normalizeEmoji(input) {
  const text = String(input).trim();
  const custom = /^<a?:\w+:(\d+)>$/.exec(text);
  return custom ? custom[1] : text;
}

async function addBinding(database, guildId, messageId, emoji, roleId) {
  await ensureSchema(database);
  const db = await database;
  await db.run(
    `INSERT INTO reaction_roles (guild_id, message_id, emoji, role_id) VALUES (?, ?, ?, ?)
     ON CONFLICT(guild_id, message_id, emoji) DO UPDATE SET role_id = excluded.role_id`,
    guildId,
    messageId,
    emoji,
    roleId,
  );
}

async function removeBinding(database, guildId, messageId, emoji) {
  await ensureSchema(database);
  const db = await database;
  const result = await db.run(
    'DELETE FROM reaction_roles WHERE guild_id = ? AND message_id = ? AND emoji = ?',
    guildId,
    messageId,
    emoji,
  );
  return result.changes > 0;
}

async function listBindings(database, guildId, messageId) {
  await ensureSchema(database);
  const db = await database;
  return db.all(
    'SELECT emoji, role_id FROM reaction_roles WHERE guild_id = ? AND message_id = ? ORDER BY id',
    guildId,
    messageId,
  );
}

async function getBinding(database, guildId, messageId, emoji) {
  await ensureSchema(database);
  const db = await database;
  return db.get(
    'SELECT role_id FROM reaction_roles WHERE guild_id = ? AND message_id = ? AND emoji = ?',
    guildId,
    messageId,
    emoji,
  );
}

module.exports = {
  ensureSchema,
  normalizeEmoji,
  addBinding,
  removeBinding,
  listBindings,
  getBinding,
};
