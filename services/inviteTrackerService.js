'use strict';

const inviteCache = new Map();
const DEFAULT_MIN_ACCOUNT_AGE_DAYS = 7;
const DEFAULT_MIN_STAY_MINUTES = 60;

async function ensureSchema(database) {
  const db = await database;
  await db.exec(`
    CREATE TABLE IF NOT EXISTS invite_joins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      joiner_id TEXT NOT NULL,
      inviter_id TEXT,
      invite_code TEXT,
      classification TEXT DEFAULT 'valid',
      account_age_days REAL,
      event_id INTEGER,
      joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      left_at TIMESTAMP,
      UNIQUE(guild_id, joiner_id)
    );

    CREATE TABLE IF NOT EXISTS invite_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      name TEXT NOT NULL,
      status TEXT DEFAULT 'active',
      started_by TEXT,
      started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      ended_at TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_invite_joins_guild_inviter ON invite_joins(guild_id, inviter_id);
    CREATE INDEX IF NOT EXISTS idx_invite_joins_event ON invite_joins(event_id);
  `);
}

function minAccountAgeDays() {
  const value = Number(process.env.INVITE_MIN_ACCOUNT_AGE_DAYS || DEFAULT_MIN_ACCOUNT_AGE_DAYS);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_MIN_ACCOUNT_AGE_DAYS;
}

function minStayMinutes() {
  const value = Number(process.env.INVITE_MIN_STAY_MINUTES || DEFAULT_MIN_STAY_MINUTES);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_MIN_STAY_MINUTES;
}

async function snapshotGuild(guild) {
  if (!guild) return;
  const invites = await guild.invites.fetch().catch(() => null);
  if (!invites) return;
  const snapshot = new Map();
  for (const invite of invites.values()) snapshot.set(invite.code, invite.uses || 0);
  inviteCache.set(guild.id, snapshot);
}

async function initializeGuild(guild, database) {
  await ensureSchema(database);
  await snapshotGuild(guild);
}

async function findUsedInvite(guild) {
  const previous = inviteCache.get(guild.id) || new Map();
  const invites = await guild.invites.fetch().catch(() => null);
  if (!invites) return null;

  let used = null;
  let biggestIncrease = 0;
  for (const invite of invites.values()) {
    const before = previous.get(invite.code) || 0;
    const increase = (invite.uses || 0) - before;
    if (increase > biggestIncrease) {
      biggestIncrease = increase;
      used = invite;
    }
  }

  const next = new Map();
  for (const invite of invites.values()) next.set(invite.code, invite.uses || 0);
  inviteCache.set(guild.id, next);
  return used;
}

async function activeEvent(db, guildId) {
  return db.get(
    "SELECT id, name, started_at FROM invite_events WHERE guild_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1",
    guildId,
  );
}

function classifyMember(member) {
  if (member.user.bot) return { classification: 'bot', ageDays: 0 };
  const ageMs = Date.now() - member.user.createdTimestamp;
  const ageDays = Math.max(0, ageMs / 86400000);
  if (ageDays < minAccountAgeDays()) return { classification: 'suspicious', ageDays };
  return { classification: 'valid', ageDays };
}

async function handleMemberAdd(member, database) {
  await ensureSchema(database);
  const db = await database;
  const used = await findUsedInvite(member.guild);
  const inviterId = used?.inviter?.id || null;
  const { classification, ageDays } = classifyMember(member);
  const event = await activeEvent(db, member.guild.id);

  await db.run(
    `INSERT INTO invite_joins (guild_id, joiner_id, inviter_id, invite_code, classification, account_age_days, event_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(guild_id, joiner_id) DO UPDATE SET
       inviter_id = excluded.inviter_id,
       invite_code = excluded.invite_code,
       classification = excluded.classification,
       account_age_days = excluded.account_age_days,
       event_id = excluded.event_id,
       joined_at = CURRENT_TIMESTAMP,
       left_at = NULL`,
    member.guild.id,
    member.id,
    inviterId,
    used?.code || null,
    classification,
    ageDays,
    event?.id || null,
  );
}

async function handleMemberRemove(member, database) {
  await ensureSchema(database);
  const db = await database;
  const row = await db.get(
    'SELECT id, classification, joined_at FROM invite_joins WHERE guild_id = ? AND joiner_id = ?',
    member.guild.id,
    member.id,
  );
  if (!row) return;

  let classification = row.classification;
  const joinedAt = new Date(row.joined_at).getTime();
  const stayedMinutes = Number.isFinite(joinedAt) ? (Date.now() - joinedAt) / 60000 : Infinity;
  if (classification === 'valid' && stayedMinutes < minStayMinutes()) classification = 'left_early';

  await db.run(
    'UPDATE invite_joins SET classification = ?, left_at = CURRENT_TIMESTAMP WHERE id = ?',
    classification,
    row.id,
  );
}

async function getStats(database, guildId, inviterId, eventId = null) {
  await ensureSchema(database);
  const db = await database;
  const params = [guildId, inviterId];
  let eventClause = '';
  if (eventId) {
    eventClause = ' AND event_id = ?';
    params.push(eventId);
  }
  const rows = await db.all(
    `SELECT classification, COUNT(*) AS count
     FROM invite_joins
     WHERE guild_id = ? AND inviter_id = ?${eventClause}
     GROUP BY classification`,
    ...params,
  );
  const stats = { valid: 0, suspicious: 0, bots: 0, leftEarly: 0, total: 0 };
  for (const row of rows) {
    const count = Number(row.count || 0);
    stats.total += count;
    if (row.classification === 'valid') stats.valid += count;
    else if (row.classification === 'suspicious') stats.suspicious += count;
    else if (row.classification === 'bot') stats.bots += count;
    else if (row.classification === 'left_early') stats.leftEarly += count;
  }
  return stats;
}

async function getLeaderboard(database, guildId, eventId = null, limit = 10) {
  await ensureSchema(database);
  const db = await database;
  const params = [guildId];
  let eventClause = '';
  if (eventId) {
    eventClause = ' AND event_id = ?';
    params.push(eventId);
  }
  params.push(limit);
  return db.all(
    `SELECT inviter_id AS inviterId,
            SUM(CASE WHEN classification = 'valid' THEN 1 ELSE 0 END) AS valid,
            SUM(CASE WHEN classification = 'suspicious' THEN 1 ELSE 0 END) AS suspicious,
            SUM(CASE WHEN classification = 'bot' THEN 1 ELSE 0 END) AS bots,
            SUM(CASE WHEN classification = 'left_early' THEN 1 ELSE 0 END) AS leftEarly,
            COUNT(*) AS total
     FROM invite_joins
     WHERE guild_id = ? AND inviter_id IS NOT NULL${eventClause}
     GROUP BY inviter_id
     ORDER BY valid DESC, total DESC
     LIMIT ?`,
    ...params,
  );
}

async function startEvent(database, guildId, name, startedBy) {
  await ensureSchema(database);
  const db = await database;
  const current = await activeEvent(db, guildId);
  if (current) return { error: `An invite event is already active: ${current.name}` };
  const result = await db.run(
    "INSERT INTO invite_events (guild_id, name, status, started_by) VALUES (?, ?, 'active', ?)",
    guildId,
    name,
    startedBy,
  );
  return { id: result.lastID, name };
}

async function endEvent(database, guildId) {
  await ensureSchema(database);
  const db = await database;
  const current = await activeEvent(db, guildId);
  if (!current) return null;
  await db.run(
    "UPDATE invite_events SET status = 'ended', ended_at = CURRENT_TIMESTAMP WHERE id = ?",
    current.id,
  );
  return current;
}

module.exports = {
  ensureSchema,
  initializeGuild,
  snapshotGuild,
  handleMemberAdd,
  handleMemberRemove,
  getStats,
  getLeaderboard,
  activeEvent,
  startEvent,
  endEvent,
  minAccountAgeDays,
  minStayMinutes,
};
