'use strict';

const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionFlagsBits,
  MessageFlags,
} = require('discord.js');
const { getSetting } = require('./settingsService');
const { notifyUser } = require('./notificationService');

const STATUS_COLOR = { pending: 0x5865f2, approved: 0x57f287, denied: 0xed4245, implemented: 0x9b59b6 };
const STATUS_LABEL = { pending: 'Pending review', approved: '✅ Approved', denied: '❌ Denied', implemented: '🔧 Implemented' };

async function ensureSchema(database) {
  const db = await database;
  await db.exec(`CREATE TABLE IF NOT EXISTS suggestion_votes (
    suggestion_id INTEGER NOT NULL,
    user_id TEXT NOT NULL,
    vote TEXT NOT NULL CHECK(vote IN ('up','down')),
    PRIMARY KEY (suggestion_id, user_id)
  );`);
}

function voteButtons(suggestionId, upvotes, downvotes, disabled = false) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`suggestion_up:${suggestionId}`).setLabel(`${upvotes}`).setEmoji('👍').setStyle(ButtonStyle.Success).setDisabled(disabled),
      new ButtonBuilder().setCustomId(`suggestion_down:${suggestionId}`).setLabel(`${downvotes}`).setEmoji('👎').setStyle(ButtonStyle.Danger).setDisabled(disabled),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`suggestion_approve:${suggestionId}`).setLabel('Approve').setEmoji('✅').setStyle(ButtonStyle.Secondary).setDisabled(disabled),
      new ButtonBuilder().setCustomId(`suggestion_deny:${suggestionId}`).setLabel('Deny').setEmoji('❌').setStyle(ButtonStyle.Secondary).setDisabled(disabled),
      new ButtonBuilder().setCustomId(`suggestion_implement:${suggestionId}`).setLabel('Implemented').setEmoji('🔧').setStyle(ButtonStyle.Secondary).setDisabled(disabled),
    ),
  ];
}

function buildEmbed(suggestion, authorTag) {
  return new EmbedBuilder()
    .setColor(STATUS_COLOR[suggestion.status] || STATUS_COLOR.pending)
    .setAuthor({ name: `Suggestion #${suggestion.id} — ${authorTag}` })
    .setDescription(suggestion.message)
    .addFields({ name: 'Status', value: STATUS_LABEL[suggestion.status] || suggestion.status, inline: true })
    .setTimestamp();
}

async function create(interaction, database, text) {
  const enabled = await getSetting(database, interaction.guild.id, 'suggestions.enabled', true);
  if (!enabled) {
    return interaction.reply({ content: '❌ Suggestions are currently disabled on this server.', flags: MessageFlags.Ephemeral });
  }

  await ensureSchema(database);
  const db = await database;

  const channelId = await getSetting(database, interaction.guild.id, 'suggestions.channelId', null);
  const channel = (channelId && interaction.guild.channels.cache.get(channelId))
    || interaction.guild.channels.cache.find((ch) => ch.name === process.env.SUGGESTIONS_CHANNEL_NAME && ch.isTextBased());
  if (!channel?.isTextBased()) {
    return interaction.reply({ content: '❌ No suggestions channel is configured. Ask a server admin to set one up.', flags: MessageFlags.Ephemeral });
  }

  const result = await db.run("INSERT INTO suggestions (user_id, message, status) VALUES (?, ?, 'pending')", interaction.user.id, text);
  const suggestion = { id: result.lastID, message: text, status: 'pending' };

  const embed = buildEmbed(suggestion, interaction.user.tag);
  const posted = await channel.send({ embeds: [embed], components: voteButtons(suggestion.id, 0, 0) }).catch(() => null);
  if (!posted) {
    return interaction.reply({ content: '❌ I could not post to the suggestions channel - check my permissions there.', flags: MessageFlags.Ephemeral });
  }

  return interaction.reply({ content: `✅ Suggestion #${suggestion.id} submitted to ${channel}!`, flags: MessageFlags.Ephemeral });
}

async function handleVote(interaction, database) {
  await ensureSchema(database);
  const db = await database;
  const [action, idText] = interaction.customId.split(':');
  const id = Number(idText);
  const vote = action === 'suggestion_up' ? 'up' : 'down';

  const suggestion = await db.get('SELECT * FROM suggestions WHERE id = ?', id);
  if (!suggestion) return interaction.reply({ content: 'That suggestion no longer exists.', flags: MessageFlags.Ephemeral });
  if (suggestion.status !== 'pending') {
    return interaction.reply({ content: `Voting is closed - this suggestion has been ${suggestion.status}.`, flags: MessageFlags.Ephemeral });
  }

  const existing = await db.get(
    'SELECT vote FROM suggestion_votes WHERE suggestion_id = ? AND user_id = ?',
    id,
    interaction.user.id,
  );

  if (existing?.vote === vote) {
    await db.run('DELETE FROM suggestion_votes WHERE suggestion_id = ? AND user_id = ?', id, interaction.user.id);
  } else {
    await db.run(
      `INSERT INTO suggestion_votes (suggestion_id, user_id, vote) VALUES (?, ?, ?)
       ON CONFLICT(suggestion_id, user_id) DO UPDATE SET vote = excluded.vote`,
      id,
      interaction.user.id,
      vote,
    );
  }

  const counts = await db.get(
    `SELECT
       SUM(CASE WHEN vote = 'up' THEN 1 ELSE 0 END) AS upvotes,
       SUM(CASE WHEN vote = 'down' THEN 1 ELSE 0 END) AS downvotes
     FROM suggestion_votes WHERE suggestion_id = ?`,
    id,
  );
  const upvotes = counts.upvotes || 0;
  const downvotes = counts.downvotes || 0;
  await db.run('UPDATE suggestions SET upvotes = ?, downvotes = ? WHERE id = ?', upvotes, downvotes, id);

  const originalEmbed = interaction.message.embeds[0];
  const embed = originalEmbed ? EmbedBuilder.from(originalEmbed) : buildEmbed(suggestion, interaction.user.tag);
  return interaction.update({ embeds: [embed], components: voteButtons(id, upvotes, downvotes) });
}

async function handleModeration(interaction, database) {
  if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
    return interaction.reply({ content: '⛔ You need Manage Server to review suggestions.', flags: MessageFlags.Ephemeral });
  }

  await ensureSchema(database);
  const db = await database;
  const [action, idText] = interaction.customId.split(':');
  const id = Number(idText);
  const suggestion = await db.get('SELECT * FROM suggestions WHERE id = ?', id);
  if (!suggestion) return interaction.reply({ content: 'That suggestion no longer exists.', flags: MessageFlags.Ephemeral });
  if (suggestion.status !== 'pending') {
    return interaction.reply({ content: `Already marked as ${suggestion.status}.`, flags: MessageFlags.Ephemeral });
  }

  const newStatus = action === 'suggestion_approve' ? 'approved' : action === 'suggestion_deny' ? 'denied' : 'implemented';
  await db.run('UPDATE suggestions SET status = ? WHERE id = ?', newStatus, id);

  const dmEnabled = await getSetting(database, interaction.guild.id, 'suggestions.dmStatusChanges', true);
  if (dmEnabled) {
    const author = await interaction.client.users.fetch(suggestion.user_id).catch(() => null);
    if (author) {
      await notifyUser(author, {
        title: `Your suggestion #${id} was ${STATUS_LABEL[newStatus]}`,
        description: suggestion.message,
        color: STATUS_COLOR[newStatus],
      });
    }
  }

  const originalEmbed = interaction.message.embeds[0];
  const embed = originalEmbed ? EmbedBuilder.from(originalEmbed).setColor(STATUS_COLOR[newStatus]) : buildEmbed({ ...suggestion, status: newStatus }, interaction.user.tag);
  const fields = embed.data.fields || [];
  const statusIndex = fields.findIndex((f) => f.name === 'Status');
  const statusField = { name: 'Status', value: `${STATUS_LABEL[newStatus]} by ${interaction.user.tag}`, inline: true };
  if (statusIndex >= 0) fields[statusIndex] = statusField; else fields.push(statusField);
  embed.setFields(fields);

  return interaction.update({ embeds: [embed], components: voteButtons(id, suggestion.upvotes, suggestion.downvotes, true) });
}

module.exports = {
  ensureSchema,
  create,
  handleVote,
  handleModeration,
};
