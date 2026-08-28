'use strict';

const timers = new Map();
const MAX_TIMEOUT = 2_000_000_000;

async function ensureSchema(database) {
  const db = await database;
  await db.exec(`CREATE TABLE IF NOT EXISTS reminders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    guild_id TEXT,
    channel_id TEXT,
    message TEXT NOT NULL,
    due_at TIMESTAMP NOT NULL,
    delivered_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );`);
}

function scheduleOne(client, database, reminder) {
  if (timers.has(reminder.id)) clearTimeout(timers.get(reminder.id));
  const due = new Date(reminder.due_at).getTime();
  const delay = Math.max(0, due - Date.now());
  const timeout = setTimeout(async () => {
    if (delay > MAX_TIMEOUT) {
      // Long-delay reminders are chained in MAX_TIMEOUT-sized hops -
      // scheduleOne() below sets its own fresh timer entry for reminder.id,
      // so don't fall through to the delete below, which would remove that
      // entry instead of this expired one.
      scheduleOne(client, database, reminder);
      return;
    }
    try {
      const db = await database;
      const fresh = await db.get('SELECT * FROM reminders WHERE id = ? AND delivered_at IS NULL', reminder.id);
      if (!fresh) return;
      const user = await client.users.fetch(fresh.user_id).catch(() => null);
      if (user) await user.send(`⏰ **KiwiVerse Reminder #${fresh.id}**\n${fresh.message}`).catch(() => null);
      await db.run('UPDATE reminders SET delivered_at = CURRENT_TIMESTAMP WHERE id = ?', fresh.id);
    } catch (error) {
      console.error(`[Reminders] Failed to deliver reminder #${reminder.id}:`, error);
    } finally {
      timers.delete(reminder.id);
    }
  }, Math.min(delay, MAX_TIMEOUT));
  timeout.unref?.();
  timers.set(reminder.id, timeout);
}

async function initialize(client, database) {
  await ensureSchema(database);
  const db = await database;
  const rows = await db.all('SELECT * FROM reminders WHERE delivered_at IS NULL ORDER BY due_at ASC');
  for (const row of rows) scheduleOne(client, database, row);
}

async function create(client, database, data) {
  await ensureSchema(database);
  const db = await database;
  const result = await db.run(
    'INSERT INTO reminders (user_id, guild_id, channel_id, message, due_at) VALUES (?, ?, ?, ?, ?)',
    data.userId,
    data.guildId || null,
    data.channelId || null,
    data.message,
    new Date(data.dueAt).toISOString(),
  );
  const reminder = await db.get('SELECT * FROM reminders WHERE id = ?', result.lastID);
  scheduleOne(client, database, reminder);
  return reminder;
}

module.exports = { ensureSchema, initialize, create };
