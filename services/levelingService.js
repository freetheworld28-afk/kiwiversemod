'use strict';

// In-memory XP cache with periodic batch persistence.
//
// Discord message -> leveling handler -> check guild settings (cached) ->
// check XP cooldown -> update XP in memory -> determine level -> announce
// level-up if needed -> periodically batch-persist dirty users to SQLite.
//
// No SQLite read or write happens on the hot path (per message). A user's
// row is lazily SELECTed into the cache at most once per process lifetime
// (until it changes and gets flushed back), and writes only happen in
// batches on a timer (see startAutoFlush) or on shutdown.

const { getSettingsByPrefix } = require('./settingsService');
const { notifyUser } = require('./notificationService');

const GUILD_SETTINGS_TTL_MS = 60_000;
const DEFAULT_FLUSH_INTERVAL_MS = 45_000;

// discordId -> { guildId, discordId, username, xp, level }
const userCache = new Map();
// discordId -> in-flight load promise, so concurrent messages from a user
// whose row isn't cached yet converge on a single SELECT instead of racing.
const loadingPromises = new Map();
// discordId -> timestamp (ms) of the last XP award, for the per-user cooldown.
const cooldowns = new Map();
// Set of discordIds with in-memory XP/level changes not yet written to SQLite.
const dirtyUsers = new Set();
// guildId -> { settings, expiresAt }
const guildSettingsCache = new Map();

let flushPromise = null;
let flushTimer = null;

const metrics = {
  messagesProcessed: 0,
  xpAwarded: 0,
  cacheHits: 0,
  cacheMisses: 0,
  flushes: 0,
  usersFlushed: 0,
  dbErrors: 0,
};

function getMetrics() {
  return { ...metrics, dirtyCount: dirtyUsers.size, cachedUsers: userCache.size };
}

async function getGuildSettings(database, guildId) {
  const cached = guildSettingsCache.get(guildId);
  if (cached && cached.expiresAt > Date.now()) return cached.settings;

  const raw = await getSettingsByPrefix(database, guildId, 'leveling');
  const settings = {
    enabled: raw.enabled ?? true,
    xpPerMessage: Number(raw.xpPerMessage) || 15,
    cooldownSeconds: Number(raw.cooldownSeconds) || 60,
    levelUpChannelId: raw.levelUpChannelId || null,
    dmLevelUp: Boolean(raw.dmLevelUp),
    ignoredChannelIds: Array.isArray(raw.ignoredChannelIds) ? raw.ignoredChannelIds : [],
    ignoredRoleIds: Array.isArray(raw.ignoredRoleIds) ? raw.ignoredRoleIds : [],
  };
  guildSettingsCache.set(guildId, { settings, expiresAt: Date.now() + GUILD_SETTINGS_TTL_MS });
  return settings;
}

// Called by the dashboard API right after it writes guild_settings, so a
// config change is picked up on the next message instead of waiting out the
// TTL. Cheap no-op if nothing was cached yet for that guild.
function invalidateGuildSettings(guildId) {
  guildSettingsCache.delete(guildId);
}

async function getUserRecord(database, guildId, discordId, username) {
  if (userCache.has(discordId)) {
    metrics.cacheHits++;
    return userCache.get(discordId);
  }

  if (loadingPromises.has(discordId)) {
    // Another concurrent message for this user already triggered the SELECT;
    // join it instead of causing a second read. This isn't a "hit" against a
    // populated cache, but it's not a fresh DB read either, so it's counted
    // as a hit for the "did this avoid a redundant SQLite read?" metric.
    metrics.cacheHits++;
    await loadingPromises.get(discordId);
    return userCache.get(discordId);
  }

  metrics.cacheMisses++;
  const loadPromise = (async () => {
    const db = await database;
    const row = await db.get('SELECT username, xp, level FROM users WHERE discord_id = ?', discordId);
    userCache.set(discordId, {
      guildId,
      discordId,
      username: row?.username || username,
      xp: row?.xp || 0,
      level: row?.level || 0,
    });
  })();
  loadingPromises.set(discordId, loadPromise);
  try {
    await loadPromise;
  } finally {
    loadingPromises.delete(discordId);
  }
  return userCache.get(discordId);
}

// Cache-aware read path for /rank, /profile, and the leaderboard. Never
// writes to SQLite - this is the exact same lazy-load used by handleMessage
// (same cache, same loadingPromises race guard), so a read command for a
// user who isn't cached yet triggers at most one SELECT and populates the
// cache for next time, without creating a second independent cache.
async function getCurrentUser(database, guildId, discordId, usernameFallback) {
  return getUserRecord(database, guildId, discordId, usernameFallback);
}

// 1-indexed rank by XP. Counts SQLite rows above `effectiveXp` for users
// who are NOT currently cached (their DB row is the source of truth), then
// adds in currently-cached users compared against their live in-memory XP -
// so a user who just gained XP in memory is ranked correctly even though
// their SQLite row hasn't been flushed yet.
async function getEffectiveRank(database, discordId, effectiveXp) {
  const db = await database;
  const cachedIds = Array.from(userCache.keys());

  let dbHigherCount;
  if (cachedIds.length === 0) {
    const row = await db.get('SELECT COUNT(*) AS count FROM users WHERE xp > ?', effectiveXp);
    dbHigherCount = row.count;
  } else {
    const placeholders = cachedIds.map(() => '?').join(',');
    const row = await db.get(
      `SELECT COUNT(*) AS count FROM users WHERE xp > ? AND discord_id NOT IN (${placeholders})`,
      effectiveXp,
      ...cachedIds,
    );
    dbHigherCount = row.count;
  }

  let cacheHigherCount = 0;
  for (const [otherId, record] of userCache.entries()) {
    if (otherId === discordId) continue;
    if (record.xp > effectiveXp) cacheHigherCount++;
  }

  return dbHigherCount + cacheHigherCount + 1;
}

// Cache-aware leaderboard: takes a generous candidate pool from SQLite (the
// persistent source of truth for users not currently active), then overlays
// every currently-cached user's live XP/level on top - this both refreshes
// stale duplicates and adds cached users who wouldn't have made the DB-side
// pool at all, so recently-earned XP is never missing from the top ranks.
async function getLeaderboard(database, limit = 10, poolSize = 100) {
  const db = await database;
  const dbRows = await db.all(
    'SELECT discord_id, username, xp, level FROM users ORDER BY xp DESC LIMIT ?',
    poolSize,
  );

  const merged = new Map();
  for (const row of dbRows) {
    merged.set(row.discord_id, {
      discordId: row.discord_id,
      username: row.username,
      xp: row.xp || 0,
      level: row.level || 0,
    });
  }
  for (const [discordId, record] of userCache.entries()) {
    merged.set(discordId, {
      discordId,
      username: record.username,
      xp: record.xp,
      level: record.level,
    });
  }

  return Array.from(merged.values())
    .sort((a, b) => b.xp - a.xp)
    .slice(0, limit);
}

async function announceLevelUp(message, settings, record) {
  await message.react('🎉').catch(() => null);

  if (settings.dmLevelUp) {
    await notifyUser(message.author, {
      title: '🎊 Level Up!',
      description: `You leveled up to **Level ${record.level}** in **${message.guild.name}**!`,
      color: 0x57f287,
    });
  }

  let channel = message.channel;
  if (settings.levelUpChannelId) {
    const configured = message.guild.channels.cache.get(settings.levelUpChannelId);
    if (configured?.isTextBased()) channel = configured;
  }
  if (channel?.isTextBased()) {
    await channel
      .send(`🎊 **${message.author.username}** leveled up to **Level ${record.level}**!`)
      .catch((error) => console.error('[leveling] failed to send level-up announcement:', error));
  }
}

async function handleMessage(message, client, database) {
  metrics.messagesProcessed++;
  if (message.author.bot || !message.guild) return;

  const guildId = message.guild.id;
  const settings = await getGuildSettings(database, guildId);
  if (!settings.enabled) return;
  if (settings.ignoredChannelIds.includes(message.channel.id)) return;
  if (
    settings.ignoredRoleIds.length
    && message.member?.roles?.cache?.some((role) => settings.ignoredRoleIds.includes(role.id))
  ) return;

  const discordId = message.author.id;
  const record = await getUserRecord(database, guildId, discordId, message.author.username);

  // Synchronous critical section from here to the dirty-mark below: no
  // `await` until the in-memory mutation is complete, so two messages from
  // the same user arriving back-to-back can't interleave and clobber each
  // other's cooldown claim or XP update (Node only yields at `await`).
  const now = Date.now();
  const cooldownMs = settings.cooldownSeconds * 1000;
  const lastAward = cooldowns.get(discordId) || 0;
  if (now - lastAward < cooldownMs) return;
  cooldowns.set(discordId, now);

  const xpGain = Math.floor(Math.random() * 11) + settings.xpPerMessage;
  const previousLevel = record.level;
  record.xp += xpGain;
  record.level = Math.floor(Math.sqrt(record.xp) / 10);
  record.username = message.author.username;
  dirtyUsers.add(discordId);
  metrics.xpAwarded += xpGain;
  // ---- end synchronous critical section ----

  if (record.level > previousLevel) {
    await announceLevelUp(message, settings, record);
  }
}

async function withRetry(fn, { retries = 3, baseDelayMs = 200 } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const isBusy = error?.code === 'SQLITE_BUSY' || /SQLITE_BUSY|database is locked/i.test(error?.message || '');
      if (!isBusy || attempt > retries) throw error;
      const delay = baseDelayMs * 2 ** (attempt - 1);
      console.warn(`[leveling] database busy, retrying flush in ${delay}ms (attempt ${attempt}/${retries})`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

async function doFlush(database) {
  if (dirtyUsers.size === 0) return { flushed: 0 };

  const keysToFlush = Array.from(dirtyUsers);
  dirtyUsers.clear();

  try {
    const db = await database;
    await withRetry(async () => {
      await db.exec('BEGIN IMMEDIATE');
      try {
        for (const discordId of keysToFlush) {
          const record = userCache.get(discordId);
          if (!record) continue;
          await db.run(
            `INSERT INTO users (discord_id, username, xp, level, last_message)
             VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
             ON CONFLICT(discord_id) DO UPDATE SET
               username = excluded.username,
               xp = excluded.xp,
               level = excluded.level,
               last_message = excluded.last_message`,
            record.discordId,
            record.username,
            record.xp,
            record.level,
          );
        }
        await db.exec('COMMIT');
      } catch (error) {
        await db.exec('ROLLBACK');
        throw error;
      }
    });

    metrics.flushes++;
    metrics.usersFlushed += keysToFlush.length;
    console.log(`[leveling] flushed ${keysToFlush.length} dirty user(s) to SQLite (${JSON.stringify(getMetrics())})`);
    return { flushed: keysToFlush.length };
  } catch (error) {
    metrics.dbErrors++;
    console.error('[leveling] flush failed, will retry these users next cycle:', error);
    // Put the unflushed keys back so the next flush retries them - nothing
    // is lost, it just stays dirty (and in memory) until a flush succeeds.
    for (const discordId of keysToFlush) dirtyUsers.add(discordId);
    return { flushed: 0, error };
  }
}

// Concurrent callers join the same in-flight flush instead of racing a
// second transaction against the same connection.
function flush(database) {
  if (flushPromise) return flushPromise;
  flushPromise = doFlush(database).finally(() => {
    flushPromise = null;
  });
  return flushPromise;
}

function startAutoFlush(database, intervalMs = DEFAULT_FLUSH_INTERVAL_MS) {
  if (flushTimer) clearInterval(flushTimer);
  flushTimer = setInterval(() => {
    flush(database).catch((error) => console.error('[leveling] scheduled flush threw:', error));
  }, intervalMs);
  flushTimer.unref?.();
}

function stopAutoFlush() {
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
}

// Drains everything dirty, including XP awarded during the drain itself.
// Used on graceful shutdown so nothing earned right before exit is lost.
async function shutdown(database) {
  stopAutoFlush();
  for (let i = 0; i < 5 && dirtyUsers.size > 0; i++) {
    await flush(database);
  }
  console.log(`[leveling] shutdown flush complete (${JSON.stringify(getMetrics())})`);
}

module.exports = {
  handleMessage,
  startAutoFlush,
  stopAutoFlush,
  flush,
  shutdown,
  invalidateGuildSettings,
  getMetrics,
  getCurrentUser,
  getEffectiveRank,
  getLeaderboard,
};
