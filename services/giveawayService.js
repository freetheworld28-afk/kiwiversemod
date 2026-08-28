'use strict';

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const { logEvent } = require('./loggingService');

const timers = new Map();
const MAX_TIMEOUT = 2_000_000_000;

async function ensureSchema(database) {
  const db = await database;
  const columns = await db.all('PRAGMA table_info(giveaways)');
  const names = columns.map((c) => c.name);
  if (!names.includes('winners_count')) await db.exec('ALTER TABLE giveaways ADD COLUMN winners_count INTEGER DEFAULT 1');
  if (!names.includes('winner_ids')) await db.exec("ALTER TABLE giveaways ADD COLUMN winner_ids TEXT DEFAULT '[]'");
  if (!names.includes('ended_at')) await db.exec('ALTER TABLE giveaways ADD COLUMN ended_at TIMESTAMP');

  // Entries live in their own table (rather than the giveaways.entries JSON
  // column) so entering/leaving is a single atomic INSERT/DELETE instead of
  // a read-modify-write of a shared JSON blob under concurrent clicks.
  await db.exec(`CREATE TABLE IF NOT EXISTS giveaway_entries (
    giveaway_id INTEGER NOT NULL,
    user_id TEXT NOT NULL,
    entered_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (giveaway_id, user_id)
  );`);
}

function entryButton(giveawayId, count, disabled = false) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`giveaway_enter:${giveawayId}`)
      .setLabel(disabled ? 'Giveaway Ended' : `🎉 Enter (${count})`)
      .setStyle(ButtonStyle.Success)
      .setDisabled(disabled),
  )];
}

function buildEmbed(giveaway, entryCount, resultText = null) {
  const embed = new EmbedBuilder()
    .setColor(resultText ? 0x99aab5 : 0x8b5cf6)
    .setTitle(`🎉 Giveaway: ${giveaway.prize}`)
    .addFields(
      { name: 'Hosted by', value: `<@${giveaway.host_id}>`, inline: true },
      { name: 'Winners', value: `${giveaway.winners_count || 1}`, inline: true },
      { name: 'Entries', value: `${entryCount}`, inline: true },
    )
    .setTimestamp(new Date(giveaway.ends_at));

  if (resultText) {
    embed.setDescription(resultText);
    embed.addFields({ name: 'Status', value: 'Ended' });
  } else {
    embed.setDescription(`Click the button below to enter!\nEnds: <t:${Math.floor(new Date(giveaway.ends_at).getTime() / 1000)}:R>`);
  }
  return embed;
}

async function endGiveaway(client, database, giveawayId, { reroll = false } = {}) {
  if (timers.has(giveawayId)) {
    clearTimeout(timers.get(giveawayId));
    timers.delete(giveawayId);
  }

  await ensureSchema(database);
  const db = await database;
  const giveaway = await db.get('SELECT * FROM giveaways WHERE id = ?', giveawayId);
  if (!giveaway) return null;
  if (giveaway.ended_at && !reroll) return giveaway;

  const entryRows = await db.all('SELECT user_id FROM giveaway_entries WHERE giveaway_id = ?', giveawayId);
  const pool = entryRows.map((r) => r.user_id);
  const winnersCount = giveaway.winners_count || 1;
  const winners = [];
  while (winners.length < winnersCount && pool.length) {
    const index = Math.floor(Math.random() * pool.length);
    winners.push(pool.splice(index, 1)[0]);
  }

  await db.run(
    'UPDATE giveaways SET winner_ids = ?, ended_at = CURRENT_TIMESTAMP WHERE id = ?',
    JSON.stringify(winners),
    giveawayId,
  );

  const channel = await client.channels.fetch(giveaway.channel_id).catch(() => null);
  const message = channel?.isTextBased() ? await channel.messages.fetch(giveaway.message_id).catch(() => null) : null;

  const resultText = winners.length
    ? `🎉 Congratulations ${winners.map((id) => `<@${id}>`).join(', ')}! You won **${giveaway.prize}**!`
    : `😢 Nobody entered **${giveaway.prize}** - no winner could be drawn.`;

  if (message) {
    const embed = buildEmbed(giveaway, entryRows.length, resultText);
    await message.edit({ embeds: [embed], components: entryButton(giveawayId, entryRows.length, true) }).catch(() => null);
  }
  if (channel?.isTextBased()) {
    await channel.send({ content: resultText, allowedMentions: { users: winners } }).catch(() => null);
  }

  for (const winnerId of winners) {
    const user = await client.users.fetch(winnerId).catch(() => null);
    if (user) await user.send(`🎉 You won **${giveaway.prize}** in a ${channel ? channel.toString() : 'server'} giveaway!`).catch(() => null);
  }

  const guild = client.guilds.cache.get(giveaway.guild_id);
  if (guild) {
    await logEvent(guild, database, 'giveawayEvent', {
      action: reroll ? 'rerolled' : 'ended',
      giveawayId,
      prize: giveaway.prize,
      winners,
    });
  }

  return { ...giveaway, ended_at: new Date().toISOString(), winner_ids: JSON.stringify(winners) };
}

function scheduleEnd(client, database, giveaway) {
  if (giveaway.ended_at) return;
  if (timers.has(giveaway.id)) clearTimeout(timers.get(giveaway.id));
  const due = new Date(giveaway.ends_at).getTime();
  const delay = Math.max(0, due - Date.now());
  const timeout = setTimeout(async () => {
    if (delay > MAX_TIMEOUT) {
      scheduleEnd(client, database, giveaway);
      return;
    }
    await endGiveaway(client, database, giveaway.id).catch((error) => console.error(`Giveaway ${giveaway.id} auto-end failed:`, error));
  }, Math.min(delay, MAX_TIMEOUT));
  timers.set(giveaway.id, timeout);
}

async function initialize(client, database) {
  await ensureSchema(database);
  const db = await database;
  const rows = await db.all('SELECT * FROM giveaways WHERE ended_at IS NULL');
  for (const row of rows) {
    if (new Date(row.ends_at).getTime() <= Date.now()) {
      await endGiveaway(client, database, row.id).catch((error) => console.error(`Giveaway ${row.id} catch-up end failed:`, error));
    } else {
      scheduleEnd(client, database, row);
    }
  }
}

async function start(interaction, database, { prize, durationMs, winnersCount, channel }) {
  await ensureSchema(database);
  const db = await database;
  const endsAt = new Date(Date.now() + durationMs);

  const result = await db.run(
    `INSERT INTO giveaways (channel_id, guild_id, prize, host_id, ends_at, winners_count)
     VALUES (?, ?, ?, ?, ?, ?)`,
    channel.id,
    interaction.guild.id,
    prize,
    interaction.user.id,
    endsAt.toISOString(),
    winnersCount,
  );
  const giveaway = await db.get('SELECT * FROM giveaways WHERE id = ?', result.lastID);

  const embed = buildEmbed(giveaway, 0);
  const posted = await channel.send({ embeds: [embed], components: entryButton(giveaway.id, 0) }).catch(() => null);
  if (!posted) {
    await db.run('DELETE FROM giveaways WHERE id = ?', giveaway.id);
    return null;
  }

  await db.run('UPDATE giveaways SET message_id = ? WHERE id = ?', posted.id, giveaway.id);
  giveaway.message_id = posted.id;
  scheduleEnd(interaction.client, database, giveaway);

  await logEvent(interaction.guild, database, 'giveawayEvent', {
    action: 'started',
    giveawayId: giveaway.id,
    prize: giveaway.prize,
    host: interaction.user,
  });

  return giveaway;
}

async function toggleEntry(interaction, database) {
  await ensureSchema(database);
  const db = await database;
  const id = Number(interaction.customId.split(':')[1]);
  const giveaway = await db.get('SELECT * FROM giveaways WHERE id = ?', id);
  if (!giveaway) return interaction.reply({ content: 'This giveaway no longer exists.', flags: MessageFlags.Ephemeral });
  if (giveaway.ended_at) return interaction.reply({ content: 'This giveaway has already ended.', flags: MessageFlags.Ephemeral });

  const existing = await db.get(
    'SELECT 1 FROM giveaway_entries WHERE giveaway_id = ? AND user_id = ?',
    id,
    interaction.user.id,
  );

  let entered;
  if (existing) {
    await db.run('DELETE FROM giveaway_entries WHERE giveaway_id = ? AND user_id = ?', id, interaction.user.id);
    entered = false;
  } else {
    await db.run('INSERT OR IGNORE INTO giveaway_entries (giveaway_id, user_id) VALUES (?, ?)', id, interaction.user.id);
    entered = true;
  }

  const countRow = await db.get('SELECT COUNT(*) AS count FROM giveaway_entries WHERE giveaway_id = ?', id);
  const entryCount = countRow.count;

  const embed = buildEmbed(giveaway, entryCount);
  await interaction.update({ embeds: [embed], components: entryButton(id, entryCount) });
  return interaction.followUp({ content: entered ? '🎉 You are entered!' : '👋 You left the giveaway.', flags: MessageFlags.Ephemeral }).catch(() => null);
}

module.exports = {
  ensureSchema,
  initialize,
  start,
  endGiveaway,
  toggleEntry,
};
