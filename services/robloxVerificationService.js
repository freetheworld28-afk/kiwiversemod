'use strict';

const crypto = require('crypto');
const axios = require('axios');
const { EmbedBuilder } = require('discord.js');
const { notifyUser } = require('./notificationService');

const MAX_ACCOUNTS = 10;
const CODE_TTL_MS = 15 * 60 * 1000;

async function ensureSchema(database) {
  const db = await database;
  await db.exec(`
    CREATE TABLE IF NOT EXISTS roblox_verification_pending (
      discord_id TEXT NOT NULL,
      roblox_id TEXT NOT NULL,
      roblox_username TEXT NOT NULL,
      code TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (discord_id, roblox_id)
    );

    CREATE INDEX IF NOT EXISTS idx_roblox_pending_expiry
      ON roblox_verification_pending(expires_at);
  `);
}

async function lookupUsername(username) {
  const response = await axios.post(
    'https://users.roblox.com/v1/usernames/users',
    { usernames: [username], excludeBannedUsers: false },
    { timeout: 10000 },
  );
  return response.data?.data?.[0] || null;
}

async function getRobloxUser(userId) {
  const response = await axios.get(`https://users.roblox.com/v1/users/${userId}`, { timeout: 10000 });
  return response.data;
}

function parseAccounts(raw) {
  try {
    const value = JSON.parse(raw || '[]');
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

async function getLinkedRecord(database, discordId) {
  const db = await database;
  const row = await db.get('SELECT * FROM verified_users WHERE discord_id = ?', discordId);
  if (!row) return { discordId, accounts: [], activeRobloxId: null, verifiedAt: null };
  return {
    discordId,
    accounts: parseAccounts(row.roblox_accounts),
    activeRobloxId: row.active_roblox_id || null,
    verifiedAt: row.verified_at || null,
  };
}

async function robloxLinkedElsewhere(database, robloxId, discordId) {
  const db = await database;
  const rows = await db.all('SELECT discord_id, roblox_accounts FROM verified_users WHERE discord_id != ?', discordId);
  return rows.some((row) => parseAccounts(row.roblox_accounts).some((account) => String(account.id) === String(robloxId)));
}

function createCode() {
  return `KIWI-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}

async function beginVerification(database, discordUser, username) {
  await ensureSchema(database);
  const resolved = await lookupUsername(username);
  if (!resolved) return { ok: false, message: 'I could not find that Roblox username.' };

  const current = await getLinkedRecord(database, discordUser.id);
  if (current.accounts.some((account) => String(account.id) === String(resolved.id))) {
    return { ok: false, message: `**${resolved.name}** is already linked to your Discord account.` };
  }
  if (current.accounts.length >= MAX_ACCOUNTS) {
    return { ok: false, message: `You already have the maximum of **${MAX_ACCOUNTS} Roblox accounts** linked.` };
  }
  if (await robloxLinkedElsewhere(database, resolved.id, discordUser.id)) {
    return { ok: false, message: 'That Roblox account is already linked to another Discord account.' };
  }

  const db = await database;
  const code = createCode();
  const expiresAt = Date.now() + CODE_TTL_MS;
  await db.run(
    `INSERT INTO roblox_verification_pending (discord_id, roblox_id, roblox_username, code, expires_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(discord_id, roblox_id)
     DO UPDATE SET roblox_username = excluded.roblox_username, code = excluded.code,
                   expires_at = excluded.expires_at, created_at = CURRENT_TIMESTAMP`,
    discordUser.id,
    String(resolved.id),
    resolved.name,
    code,
    expiresAt,
  );

  return { ok: true, roblox: resolved, code, expiresAt };
}

async function confirmVerification(database, discordUser, username) {
  await ensureSchema(database);
  const resolved = await lookupUsername(username);
  if (!resolved) return { ok: false, message: 'I could not find that Roblox username.' };

  const db = await database;
  const pending = await db.get(
    'SELECT * FROM roblox_verification_pending WHERE discord_id = ? AND roblox_id = ?',
    discordUser.id,
    String(resolved.id),
  );
  if (!pending) return { ok: false, message: 'No pending verification exists for that account. Run `/roblox verify` first.' };
  if (Number(pending.expires_at) <= Date.now()) {
    await db.run('DELETE FROM roblox_verification_pending WHERE discord_id = ? AND roblox_id = ?', discordUser.id, String(resolved.id));
    return { ok: false, message: 'That verification code expired. Run `/roblox verify` again.' };
  }

  const profile = await getRobloxUser(resolved.id);
  const description = profile?.description || '';
  if (!description.includes(pending.code)) {
    return { ok: false, message: `I could not find **${pending.code}** in the Roblox profile description yet.` };
  }

  const current = await getLinkedRecord(database, discordUser.id);
  if (current.accounts.length >= MAX_ACCOUNTS) return { ok: false, message: `You already have ${MAX_ACCOUNTS} linked accounts.` };
  if (await robloxLinkedElsewhere(database, resolved.id, discordUser.id)) return { ok: false, message: 'That Roblox account is linked to another Discord account.' };

  const account = {
    id: String(profile.id),
    username: profile.name,
    displayName: profile.displayName || profile.name,
    verifiedAt: new Date().toISOString(),
  };
  const accounts = [...current.accounts.filter((a) => String(a.id) !== String(account.id)), account];
  const activeId = current.activeRobloxId || account.id;

  await db.run(
    `INSERT INTO verified_users (discord_id, roblox_accounts, active_roblox_id, verified_at)
     VALUES (?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(discord_id)
     DO UPDATE SET roblox_accounts = excluded.roblox_accounts,
                   active_roblox_id = excluded.active_roblox_id,
                   verified_at = CURRENT_TIMESTAMP`,
    discordUser.id,
    JSON.stringify(accounts),
    activeId,
  );
  await db.run('DELETE FROM roblox_verification_pending WHERE discord_id = ? AND roblox_id = ?', discordUser.id, String(account.id));

  await notifyUser(discordUser, {
    title: '✅ Roblox account verified',
    description: `**${account.username}** has been linked to your KiwiVerse Discord account.`,
    color: 0x57f287,
    fields: [
      { name: 'Linked accounts', value: `${accounts.length}/${MAX_ACCOUNTS}`, inline: true },
      { name: 'Active account', value: String(activeId) === String(account.id) ? 'Yes' : 'No', inline: true },
    ],
  });

  return { ok: true, account, accounts, activeRobloxId: activeId };
}

async function setActive(database, discordId, username) {
  const resolved = await lookupUsername(username);
  if (!resolved) return { ok: false, message: 'I could not find that Roblox username.' };
  const current = await getLinkedRecord(database, discordId);
  if (!current.accounts.some((account) => String(account.id) === String(resolved.id))) {
    return { ok: false, message: 'That Roblox account is not linked to your Discord account.' };
  }
  const db = await database;
  await db.run('UPDATE verified_users SET active_roblox_id = ? WHERE discord_id = ?', String(resolved.id), discordId);
  return { ok: true, account: current.accounts.find((account) => String(account.id) === String(resolved.id)) };
}

async function unlink(database, discordId, username) {
  const resolved = await lookupUsername(username);
  if (!resolved) return { ok: false, message: 'I could not find that Roblox username.' };
  const current = await getLinkedRecord(database, discordId);
  const exists = current.accounts.some((account) => String(account.id) === String(resolved.id));
  if (!exists) return { ok: false, message: 'That Roblox account is not linked to your Discord account.' };

  const accounts = current.accounts.filter((account) => String(account.id) !== String(resolved.id));
  const activeId = String(current.activeRobloxId) === String(resolved.id) ? (accounts[0]?.id || null) : current.activeRobloxId;
  const db = await database;
  if (!accounts.length) {
    await db.run('DELETE FROM verified_users WHERE discord_id = ?', discordId);
  } else {
    await db.run(
      'UPDATE verified_users SET roblox_accounts = ?, active_roblox_id = ? WHERE discord_id = ?',
      JSON.stringify(accounts),
      activeId,
      discordId,
    );
  }
  return { ok: true, accounts, activeRobloxId: activeId };
}

function accountsEmbed(record, discordUser) {
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('🎮 Linked Roblox Accounts')
    .setDescription(`Discord: ${discordUser}\nLinked: **${record.accounts.length}/${MAX_ACCOUNTS}**`);

  if (!record.accounts.length) {
    embed.addFields({ name: 'No linked accounts', value: 'Use `/roblox verify username:<name>` to get started.' });
    return embed;
  }

  record.accounts.forEach((account, index) => {
    const active = String(account.id) === String(record.activeRobloxId) ? ' ⭐ ACTIVE' : '';
    embed.addFields({
      name: `${index + 1}. ${account.username}${active}`,
      value: `Display: ${account.displayName || account.username}\nID: ${account.id}`,
    });
  });
  return embed;
}

module.exports = {
  MAX_ACCOUNTS,
  ensureSchema,
  beginVerification,
  confirmVerification,
  getLinkedRecord,
  setActive,
  unlink,
  accountsEmbed,
};
