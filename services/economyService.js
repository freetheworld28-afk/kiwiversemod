'use strict';

const { getSetting } = require('./settingsService');

async function getStartingBalance(database, guildId) {
  const value = Number(await getSetting(database, guildId, 'economy.startingBalance', 1000));
  return Number.isFinite(value) ? value : 1000;
}

async function ensureUserRow(db, discordId, username, startingBalance) {
  await db.run(
    `INSERT INTO users (discord_id, username, balance) VALUES (?, ?, ?)
     ON CONFLICT(discord_id) DO UPDATE SET username = excluded.username`,
    discordId,
    username,
    startingBalance,
  );
}

// Atomically applies `delta` to a user's balance in a single guarded UPDATE,
// refusing the change (applied: false) if it would take the balance below 0.
// Creates the row with the guild's configured starting balance first if the
// user doesn't have one yet. Safe under concurrent calls for the same user -
// there is no read-then-write gap around the balance check.
async function applyBalanceDelta(database, guildId, discordId, username, delta) {
  const db = await database;
  const startingBalance = await getStartingBalance(database, guildId);
  await ensureUserRow(db, discordId, username, startingBalance);

  const result = await db.run(
    'UPDATE users SET balance = balance + ? WHERE discord_id = ? AND balance + ? >= 0',
    delta,
    discordId,
    delta,
  );

  const row = await db.get('SELECT balance FROM users WHERE discord_id = ?', discordId);
  return { applied: result.changes > 0, balance: row?.balance ?? startingBalance };
}

// Claims the daily reward atomically: the cooldown check and the credit
// happen in one guarded UPDATE, closing the race where two concurrent
// /daily calls both pass a separate cooldown check before either write lands.
async function claimDaily(database, guildId, discordId, username, reward, cooldownMs) {
  const db = await database;
  const startingBalance = await getStartingBalance(database, guildId);
  await ensureUserRow(db, discordId, username, startingBalance);

  const now = Date.now();
  const cutoff = new Date(now - cooldownMs).toISOString();
  const claimedAt = new Date(now).toISOString();

  const result = await db.run(
    `UPDATE users SET balance = balance + ?, last_daily = ?
     WHERE discord_id = ? AND (last_daily IS NULL OR last_daily <= ?)`,
    reward,
    claimedAt,
    discordId,
    cutoff,
  );

  const row = await db.get('SELECT balance, last_daily FROM users WHERE discord_id = ?', discordId);
  return { claimed: result.changes > 0, balance: row.balance, lastDaily: row.last_daily };
}

module.exports = {
  getStartingBalance,
  ensureUserRow,
  applyBalanceDelta,
  claimDaily,
};
