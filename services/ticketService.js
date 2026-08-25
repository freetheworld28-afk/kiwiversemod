'use strict';

const {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  ModalBuilder,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const { notifyUser } = require('./notificationService');

const CATEGORY_OPTIONS = [
  ['player-support', 'Player Support', 'General help with the game or community', '🎮'],
  ['bug-report', 'Bug Report', 'Report a bug in the Roblox game', '🐛'],
  ['ban-appeal', 'Ban Appeal', 'Appeal a Discord or game moderation action', '⚖️'],
  ['purchase-issue', 'Purchase Issue', 'Help with purchases or missing rewards', '💳'],
  ['roblox-verification', 'Roblox Verification', 'Help linking or verifying Roblox accounts', '✅'],
  ['staff-report', 'Staff Report', 'Privately report a staff concern', '🛡️'],
  ['other', 'Other', 'Anything that does not fit another category', '❓'],
];

function staffRoleIds() {
  return [
    process.env.TRIAL_MOD_ROLE_ID,
    process.env.MOD_ROLE_ID,
    process.env.SR_MOD_ROLE_ID,
    process.env.ADMIN_ROLE_ID,
    process.env.TICKET_STAFF_ROLE_ID,
  ].filter(Boolean);
}

function isStaff(member) {
  if (!member) return false;
  if (member.permissions?.has(PermissionFlagsBits.ManageChannels)) return true;
  return staffRoleIds().some((id) => member.roles?.cache?.has(id));
}

async function ensureSchema(database) {
  const db = await database;
  await db.exec(`
    CREATE TABLE IF NOT EXISTS tickets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id TEXT UNIQUE,
      user_id TEXT,
      guild_id TEXT,
      category TEXT DEFAULT 'other',
      reason TEXT,
      status TEXT DEFAULT 'open',
      claimed_by TEXT,
      closed_by TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      closed_at TIMESTAMP
    );
  `);

  const columns = await db.all('PRAGMA table_info(tickets)');
  const names = new Set(columns.map((c) => c.name));
  const additions = [
    ['category', "TEXT DEFAULT 'other'"],
    ['reason', 'TEXT'],
    ['claimed_by', 'TEXT'],
    ['closed_by', 'TEXT'],
  ];

  for (const [name, type] of additions) {
    if (!names.has(name)) await db.exec(`ALTER TABLE tickets ADD COLUMN ${name} ${type}`);
  }
}

function buildPanel() {
  const embed = new EmbedBuilder()
    .setColor(0x57f287)
    .setTitle('🎫 KiwiVerse Support')
    .setDescription('Choose the category that best matches what you need help with. A private ticket will be created for you and the staff team.')
    .addFields({ name: 'Before opening a ticket', value: 'Please include enough detail for staff to understand the problem. For game issues, include your Roblox username where useful.' })
    .setFooter({ text: 'One open ticket per category per member.' });

  const select = new StringSelectMenuBuilder()
    .setCustomId('ticket_category')
    .setPlaceholder('Choose a ticket category')
    .addOptions(CATEGORY_OPTIONS.map(([value, label, description, emoji]) => ({ value, label, description, emoji })));

  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(select)] };
}

function buildReasonModal(category) {
  const label = CATEGORY_OPTIONS.find(([value]) => value === category)?.[1] || 'Support';
  const modal = new ModalBuilder().setCustomId(`ticket_create:${category}`).setTitle(`${label} Ticket`);
  const reason = new TextInputBuilder()
    .setCustomId('reason')
    .setLabel('What do you need help with?')
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMinLength(10)
    .setMaxLength(1000)
    .setPlaceholder('Explain the issue with as much useful detail as possible.');
  modal.addComponents(new ActionRowBuilder().addComponents(reason));
  return modal;
}

function ticketControls(claimed = false, closed = false) {
  if (closed) {
    return [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('ticket_reopen').setLabel('Reopen').setStyle(ButtonStyle.Success).setEmoji('🔓'),
      new ButtonBuilder().setCustomId('ticket_delete').setLabel('Delete').setStyle(ButtonStyle.Danger).setEmoji('🗑️'),
    )];
  }
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(claimed ? 'ticket_unclaim' : 'ticket_claim').setLabel(claimed ? 'Unclaim' : 'Claim').setStyle(ButtonStyle.Primary).setEmoji('🙋'),
    new ButtonBuilder().setCustomId('ticket_close').setLabel('Close').setStyle(ButtonStyle.Danger).setEmoji('🔒'),
  )];
}

async function getTicket(database, channelId) {
  await ensureSchema(database);
  const db = await database;
  return db.get('SELECT * FROM tickets WHERE channel_id = ?', channelId);
}

async function createTicket(interaction, database, category, reason) {
  await ensureSchema(database);
  const db = await database;

  const existing = await db.get(
    "SELECT * FROM tickets WHERE guild_id = ? AND user_id = ? AND category = ? AND status = 'open'",
    interaction.guild.id,
    interaction.user.id,
    category,
  );
  if (existing) {
    return interaction.reply({ content: `You already have an open ticket for this category: <#${existing.channel_id}>`, ephemeral: true });
  }

  const overwrites = [
    { id: interaction.guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles] },
    { id: interaction.client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles] },
    ...staffRoleIds().map((id) => ({ id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles] })),
  ];

  const safeName = interaction.user.username.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 18) || 'member';
  const channel = await interaction.guild.channels.create({
    name: `ticket-${safeName}`,
    type: ChannelType.GuildText,
    parent: process.env.TICKET_CATEGORY_ID || null,
    topic: `Ticket opened by ${interaction.user.tag} (${interaction.user.id}) | ${category}`,
    permissionOverwrites: overwrites,
  });

  const result = await db.run(
    'INSERT INTO tickets (channel_id, user_id, guild_id, category, reason, status) VALUES (?, ?, ?, ?, ?, ?)',
    channel.id,
    interaction.user.id,
    interaction.guild.id,
    category,
    reason,
    'open',
  );

  const categoryLabel = CATEGORY_OPTIONS.find(([value]) => value === category)?.[1] || category;
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(`🎫 Ticket #${result.lastID} — ${categoryLabel}`)
    .setDescription(`<@${interaction.user.id}>, staff will respond here when available.`)
    .addFields(
      { name: 'Opened by', value: `${interaction.user.tag} (${interaction.user.id})` },
      { name: 'Reason', value: reason },
      { name: 'Status', value: 'Open', inline: true },
      { name: 'Claimed by', value: 'Nobody', inline: true },
    )
    .setTimestamp();

  await channel.send({ content: `<@${interaction.user.id}> ${staffRoleIds().map((id) => `<@&${id}>`).join(' ')}`.trim(), embeds: [embed], components: ticketControls(false, false) });

  const dm = await notifyUser(interaction.user, {
    title: '🎫 Your KiwiVerse ticket was created',
    description: `Your **${categoryLabel}** ticket has been opened in **${interaction.guild.name}**.`,
    color: 0x57f287,
    fields: [{ name: 'Reason', value: reason }],
  });

  await interaction.reply({ content: `Ticket created: ${channel}${dm.delivered ? ' • DM sent.' : ' • I could not DM you because Discord blocked delivery.'}`, ephemeral: true });
}

async function fetchTranscript(channel) {
  let before;
  const messages = [];
  while (messages.length < 1000) {
    const batch = await channel.messages.fetch({ limit: 100, before });
    if (!batch.size) break;
    messages.push(...batch.values());
    before = batch.last().id;
    if (batch.size < 100) break;
  }

  messages.sort((a, b) => a.createdTimestamp - b.createdTimestamp);
  const lines = messages.map((m) => {
    const stamp = new Date(m.createdTimestamp).toISOString();
    const attachments = [...m.attachments.values()].map((a) => a.url).join(' ');
    return `[${stamp}] ${m.author?.tag || 'Unknown'} (${m.author?.id || 'unknown'}): ${m.cleanContent || ''}${attachments ? ` ${attachments}` : ''}`;
  });
  return Buffer.from(lines.join('\n') || 'No messages were available for this ticket.', 'utf8');
}

async function sendTranscript(interaction, database, ticket) {
  const transcript = await fetchTranscript(interaction.channel);
  const fileName = `ticket-${ticket.id}-${interaction.channel.id}.txt`;
  const attachment = new AttachmentBuilder(transcript, { name: fileName });

  const archiveId = process.env.TICKET_TRANSCRIPT_CHANNEL_ID;
  if (archiveId) {
    const archive = await interaction.guild.channels.fetch(archiveId).catch(() => null);
    if (archive?.isTextBased()) {
      await archive.send({
        content: `Transcript for ticket #${ticket.id} • <@${ticket.user_id}> • closed by <@${interaction.user.id}>`,
        files: [attachment],
      }).catch(() => null);
    }
  }

  const opener = await interaction.client.users.fetch(ticket.user_id).catch(() => null);
  let dmResult = { delivered: false, error: 'User unavailable' };
  if (opener) {
    dmResult = await notifyUser(opener, {
      title: `🔒 KiwiVerse ticket #${ticket.id} closed`,
      description: `Your ticket in **${interaction.guild.name}** has been closed. A transcript is attached for your records.`,
      color: 0xed4245,
      fields: [{ name: 'Category', value: ticket.category || 'other' }],
      files: [new AttachmentBuilder(transcript, { name: fileName })],
    });
  }
  return dmResult;
}

async function handleButton(interaction, database) {
  const ticket = await getTicket(database, interaction.channelId);
  if (!ticket) return interaction.reply({ content: 'This channel is not registered as a ticket.', ephemeral: true });
  const db = await database;

  if (interaction.customId === 'ticket_claim' || interaction.customId === 'ticket_unclaim') {
    if (!isStaff(interaction.member)) return interaction.reply({ content: 'Only staff can claim tickets.', ephemeral: true });
    const claiming = interaction.customId === 'ticket_claim';
    await db.run('UPDATE tickets SET claimed_by = ? WHERE channel_id = ?', claiming ? interaction.user.id : null, interaction.channelId);
    await interaction.update({ components: ticketControls(claiming, false) });
    return interaction.followUp({ content: claiming ? `🙋 Ticket claimed by <@${interaction.user.id}>.` : `Ticket unclaimed by <@${interaction.user.id}>.` });
  }

  if (interaction.customId === 'ticket_close') {
    if (interaction.user.id !== ticket.user_id && !isStaff(interaction.member)) return interaction.reply({ content: 'Only the ticket owner or staff can close this ticket.', ephemeral: true });
    await interaction.deferUpdate();
    const dm = await sendTranscript(interaction, database, ticket);
    await db.run("UPDATE tickets SET status = 'closed', closed_by = ?, closed_at = CURRENT_TIMESTAMP WHERE channel_id = ?", interaction.user.id, interaction.channelId);
    await interaction.channel.permissionOverwrites.edit(ticket.user_id, { SendMessages: false }).catch(() => null);
    const controlMessage = interaction.message;
    await controlMessage.edit({ components: ticketControls(false, true) }).catch(() => null);
    return interaction.followUp(`🔒 Ticket closed by <@${interaction.user.id}>. ${dm.delivered ? 'The member was DM’d a transcript.' : 'Discord would not deliver the member DM; the transcript remains available to staff.'}`);
  }

  if (interaction.customId === 'ticket_reopen') {
    if (!isStaff(interaction.member)) return interaction.reply({ content: 'Only staff can reopen tickets.', ephemeral: true });
    await db.run("UPDATE tickets SET status = 'open', closed_by = NULL, closed_at = NULL WHERE channel_id = ?", interaction.channelId);
    await interaction.channel.permissionOverwrites.edit(ticket.user_id, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true }).catch(() => null);
    await interaction.update({ components: ticketControls(Boolean(ticket.claimed_by), false) });
    const opener = await interaction.client.users.fetch(ticket.user_id).catch(() => null);
    if (opener) await notifyUser(opener, { title: `🔓 KiwiVerse ticket #${ticket.id} reopened`, description: `Your ticket in **${interaction.guild.name}** has been reopened by staff.`, color: 0x57f287 });
    return interaction.followUp(`🔓 Ticket reopened by <@${interaction.user.id}>.`);
  }

  if (interaction.customId === 'ticket_delete') {
    if (!isStaff(interaction.member)) return interaction.reply({ content: 'Only staff can delete ticket channels.', ephemeral: true });
    await interaction.reply({ content: '🗑️ Deleting this ticket channel in 3 seconds…' });
    setTimeout(() => interaction.channel.delete(`Ticket #${ticket.id} deleted by ${interaction.user.tag}`).catch(() => null), 3000);
  }
}

async function addUser(interaction, database, user) {
  const ticket = await getTicket(database, interaction.channelId);
  if (!ticket) return interaction.reply({ content: 'Use this command inside a ticket channel.', ephemeral: true });
  if (!isStaff(interaction.member)) return interaction.reply({ content: 'Only staff can add users to tickets.', ephemeral: true });
  await interaction.channel.permissionOverwrites.edit(user.id, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true, AttachFiles: true });
  return interaction.reply({ content: `➕ ${user} was added to this ticket.` });
}

async function removeUser(interaction, database, user) {
  const ticket = await getTicket(database, interaction.channelId);
  if (!ticket) return interaction.reply({ content: 'Use this command inside a ticket channel.', ephemeral: true });
  if (!isStaff(interaction.member)) return interaction.reply({ content: 'Only staff can remove users from tickets.', ephemeral: true });
  if (user.id === ticket.user_id) return interaction.reply({ content: 'The ticket owner cannot be removed. Close the ticket instead.', ephemeral: true });
  await interaction.channel.permissionOverwrites.delete(user.id).catch(() => null);
  return interaction.reply({ content: `➖ ${user} was removed from this ticket.` });
}

module.exports = {
  buildPanel,
  buildReasonModal,
  createTicket,
  handleButton,
  addUser,
  removeUser,
  ensureSchema,
};
