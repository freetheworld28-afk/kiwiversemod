'use strict';

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  ModalBuilder,
  PermissionFlagsBits,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const { notifyUser } = require('./notificationService');

async function ensureSchema(database) {
  const db = await database;
  await db.exec(`
    CREATE TABLE IF NOT EXISTS applications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      username TEXT,
      application_type TEXT DEFAULT 'staff',
      answers TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      review_channel_id TEXT,
      review_message_id TEXT,
      reviewed_by TEXT,
      review_note TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      reviewed_at TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_applications_guild_status
      ON applications(guild_id, status);
  `);
}

function reviewerRoleIds() {
  return [
    process.env.SR_MOD_ROLE_ID,
    process.env.ADMIN_ROLE_ID,
    process.env.APPLICATION_REVIEWER_ROLE_ID,
  ].filter(Boolean);
}

function isReviewer(member) {
  if (!member) return false;
  if (member.permissions?.has(PermissionFlagsBits.ManageGuild)) return true;
  return reviewerRoleIds().some((id) => member.roles?.cache?.has(id));
}

function buildPanel() {
  const embed = new EmbedBuilder()
    .setColor(0x8b5cf6)
    .setTitle('📝 KiwiVerse Applications')
    .setDescription('Want to join the KiwiVerse team? Press **Apply** below and answer the questions honestly. Staff will review your application and you will be DM’d when a decision is made.')
    .addFields(
      { name: 'Before applying', value: 'Make sure your DMs are open so KiwiVerse can send you the result.' },
      { name: 'Application type', value: 'Staff application' },
    )
    .setFooter({ text: 'One pending application per member.' });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('apply_start').setLabel('Apply').setEmoji('📝').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('apply_status').setLabel('My Application').setEmoji('📋').setStyle(ButtonStyle.Secondary),
  );

  return { embeds: [embed], components: [row] };
}

function buildApplicationModal() {
  const modal = new ModalBuilder()
    .setCustomId('apply_submit')
    .setTitle('KiwiVerse Staff Application');

  const age = new TextInputBuilder().setCustomId('age').setLabel('How old are you?').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(30);
  const timezone = new TextInputBuilder().setCustomId('timezone').setLabel('Timezone / country').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(80);
  const experience = new TextInputBuilder().setCustomId('experience').setLabel('Previous moderation or staff experience').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(1000);
  const why = new TextInputBuilder().setCustomId('why').setLabel('Why do you want to join KiwiVerse staff?').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(1000);
  const activity = new TextInputBuilder().setCustomId('activity').setLabel('How active can you be each week?').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(500);

  modal.addComponents(
    new ActionRowBuilder().addComponents(age),
    new ActionRowBuilder().addComponents(timezone),
    new ActionRowBuilder().addComponents(experience),
    new ActionRowBuilder().addComponents(why),
    new ActionRowBuilder().addComponents(activity),
  );
  return modal;
}

function decisionButtons(id, disabled = false) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`apply_accept:${id}`).setLabel('Accept').setEmoji('✅').setStyle(ButtonStyle.Success).setDisabled(disabled),
    new ButtonBuilder().setCustomId(`apply_reject:${id}`).setLabel('Reject').setEmoji('❌').setStyle(ButtonStyle.Danger).setDisabled(disabled),
    new ButtonBuilder().setCustomId(`apply_interview:${id}`).setLabel('Interview').setEmoji('💬').setStyle(ButtonStyle.Primary).setDisabled(disabled),
  )];
}

async function getOrCreateReviewChannel(interaction) {
  const configuredId = process.env.APPLICATION_REVIEW_CHANNEL_ID;
  if (configuredId) {
    const configured = await interaction.guild.channels.fetch(configuredId).catch(() => null);
    if (configured?.isTextBased()) return configured;
  }

  const existing = interaction.guild.channels.cache.find((channel) => channel.type === ChannelType.GuildText && channel.name === 'staff-applications');
  if (existing) return existing;

  const overwrites = [
    { id: interaction.guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    {
      id: interaction.client.user.id,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.EmbedLinks],
    },
  ];

  for (const roleId of reviewerRoleIds()) {
    overwrites.push({
      id: roleId,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
    });
  }

  const channel = await interaction.guild.channels.create({
    name: 'staff-applications',
    type: ChannelType.GuildText,
    topic: 'Private KiwiVerse staff application reviews',
    permissionOverwrites: overwrites,
    reason: 'Created automatically for KiwiVerse staff applications',
  });
  return channel;
}

function buildReviewEmbed(id, interaction, answers) {
  return new EmbedBuilder()
    .setColor(0xfee75c)
    .setTitle(`📝 Staff Application #${id}`)
    .setDescription(`Applicant: <@${interaction.user.id}> (${interaction.user.tag})`)
    .addFields(
      { name: 'Age', value: answers.age },
      { name: 'Timezone / Country', value: answers.timezone },
      { name: 'Experience', value: answers.experience },
      { name: 'Why KiwiVerse?', value: answers.why },
      { name: 'Weekly Activity', value: answers.activity },
      { name: 'Status', value: 'Pending review' },
    )
    .setThumbnail(interaction.user.displayAvatarURL({ size: 256 }))
    .setTimestamp();
}

async function startApplication(interaction, database) {
  await ensureSchema(database);
  const db = await database;
  const pending = await db.get(
    "SELECT id FROM applications WHERE guild_id = ? AND user_id = ? AND status IN ('pending','interview') ORDER BY id DESC LIMIT 1",
    interaction.guild.id,
    interaction.user.id,
  );
  if (pending) return interaction.reply({ content: `You already have an active application (#${pending.id}).`, ephemeral: true });
  return interaction.showModal(buildApplicationModal());
}

async function submitApplication(interaction, database) {
  await ensureSchema(database);
  const db = await database;

  const answers = {
    age: interaction.fields.getTextInputValue('age'),
    timezone: interaction.fields.getTextInputValue('timezone'),
    experience: interaction.fields.getTextInputValue('experience'),
    why: interaction.fields.getTextInputValue('why'),
    activity: interaction.fields.getTextInputValue('activity'),
  };

  const existing = await db.get(
    "SELECT id FROM applications WHERE guild_id = ? AND user_id = ? AND status IN ('pending','interview') ORDER BY id DESC LIMIT 1",
    interaction.guild.id,
    interaction.user.id,
  );
  if (existing) return interaction.reply({ content: `You already have an active application (#${existing.id}).`, ephemeral: true });

  const result = await db.run(
    `INSERT INTO applications (guild_id, user_id, username, application_type, answers, status)
     VALUES (?, ?, ?, 'staff', ?, 'pending')`,
    interaction.guild.id,
    interaction.user.id,
    interaction.user.username,
    JSON.stringify(answers),
  );

  let reviewChannel = null;
  let reviewMessage = null;
  try {
    reviewChannel = await getOrCreateReviewChannel(interaction);
    if (reviewChannel?.isTextBased()) {
      reviewMessage = await reviewChannel.send({ embeds: [buildReviewEmbed(result.lastID, interaction, answers)], components: decisionButtons(result.lastID) });
      await db.run('UPDATE applications SET review_channel_id = ?, review_message_id = ? WHERE id = ?', reviewChannel.id, reviewMessage.id, result.lastID);
    }
  } catch (error) {
    console.error('Failed to create/post application review:', error);
  }

  await notifyUser(interaction.user, {
    title: '📝 KiwiVerse application received',
    description: `Your staff application **#${result.lastID}** has been submitted and is waiting for review.`,
    color: 0x8b5cf6,
  });

  const reviewInfo = reviewMessage ? ` Staff can review it in ${reviewChannel}.` : ' ⚠️ The application was saved, but no review message could be posted; check bot channel permissions.';
  return interaction.reply({ content: `✅ Application #${result.lastID} submitted successfully.${reviewInfo}`, ephemeral: true });
}

async function showStatus(interaction, database) {
  await ensureSchema(database);
  const db = await database;
  const app = await db.get(
    'SELECT id, status, reviewed_by, review_note, created_at, reviewed_at FROM applications WHERE guild_id = ? AND user_id = ? ORDER BY id DESC LIMIT 1',
    interaction.guild.id,
    interaction.user.id,
  );
  if (!app) return interaction.reply({ content: 'You have not submitted an application yet.', ephemeral: true });

  const label = app.status === 'accepted' ? '✅ Accepted' : app.status === 'rejected' ? '❌ Rejected' : app.status === 'interview' ? '💬 Interview requested' : '⏳ Pending';
  const embed = new EmbedBuilder()
    .setColor(app.status === 'accepted' ? 0x57f287 : app.status === 'rejected' ? 0xed4245 : 0xfee75c)
    .setTitle(`Application #${app.id}`)
    .addFields(
      { name: 'Status', value: label },
      { name: 'Submitted', value: `<t:${Math.floor(new Date(app.created_at).getTime() / 1000)}:R>` },
    );
  if (app.reviewed_by) embed.addFields({ name: 'Reviewed by', value: `<@${app.reviewed_by}>` });
  if (app.review_note) embed.addFields({ name: 'Staff note', value: app.review_note });
  return interaction.reply({ embeds: [embed], ephemeral: true });
}

async function listApplications(interaction, database) {
  if (!isReviewer(interaction.member)) return interaction.reply({ content: 'Only authorized staff can view applications.', ephemeral: true });
  await ensureSchema(database);
  const db = await database;
  const rows = await db.all(
    `SELECT id, user_id, username, status, created_at FROM applications
     WHERE guild_id = ? ORDER BY CASE status WHEN 'pending' THEN 0 WHEN 'interview' THEN 1 ELSE 2 END, id DESC LIMIT 25`,
    interaction.guild.id,
  );
  if (!rows.length) return interaction.reply({ content: 'No applications have been submitted yet.', ephemeral: true });

  const lines = rows.map((app) => `**#${app.id}** • <@${app.user_id}> • **${app.status}** • <t:${Math.floor(new Date(app.created_at).getTime() / 1000)}:R>`).join('\n');
  const embed = new EmbedBuilder().setColor(0x8b5cf6).setTitle('📋 KiwiVerse Applications').setDescription(lines).setFooter({ text: 'Use /apply review <id> to open a review card.' });
  return interaction.reply({ embeds: [embed], ephemeral: true });
}

async function reviewApplication(interaction, database, id) {
  if (!isReviewer(interaction.member)) return interaction.reply({ content: 'Only authorized staff can review applications.', ephemeral: true });
  await ensureSchema(database);
  const db = await database;
  const app = await db.get('SELECT * FROM applications WHERE id = ? AND guild_id = ?', id, interaction.guild.id);
  if (!app) return interaction.reply({ content: `Application #${id} was not found.`, ephemeral: true });

  let answers = {};
  try { answers = JSON.parse(app.answers || '{}'); } catch { answers = {}; }
  const applicant = await interaction.client.users.fetch(app.user_id).catch(() => null);
  const fakeInteraction = { user: applicant || { id: app.user_id, tag: app.username || app.user_id, displayAvatarURL: () => null } };
  const embed = buildReviewEmbed(app.id, fakeInteraction, {
    age: answers.age || '—', timezone: answers.timezone || '—', experience: answers.experience || '—', why: answers.why || '—', activity: answers.activity || '—',
  }).spliceFields(-1, 1, { name: 'Status', value: app.status });

  return interaction.reply({ embeds: [embed], components: decisionButtons(app.id, !['pending', 'interview'].includes(app.status)), ephemeral: true });
}

async function handleDecision(interaction, database) {
  if (!isReviewer(interaction.member)) return interaction.reply({ content: 'Only authorized staff can review applications.', ephemeral: true });

  await ensureSchema(database);
  const db = await database;
  const [action, idText] = interaction.customId.split(':');
  const id = Number(idText);
  if (!Number.isInteger(id)) return interaction.reply({ content: 'Invalid application ID.', ephemeral: true });

  const app = await db.get('SELECT * FROM applications WHERE id = ? AND guild_id = ?', id, interaction.guild.id);
  if (!app) return interaction.reply({ content: 'Application not found.', ephemeral: true });
  if (!['pending', 'interview'].includes(app.status)) return interaction.reply({ content: `Application #${id} has already been ${app.status}.`, ephemeral: true });

  const newStatus = action === 'apply_accept' ? 'accepted' : action === 'apply_reject' ? 'rejected' : 'interview';
  await db.run('UPDATE applications SET status = ?, reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP WHERE id = ?', newStatus, interaction.user.id, id);

  const applicant = await interaction.client.users.fetch(app.user_id).catch(() => null);
  if (applicant) {
    await notifyUser(applicant, {
      title: newStatus === 'accepted' ? '✅ Your KiwiVerse application was accepted' : newStatus === 'rejected' ? '❌ Your KiwiVerse application was not accepted' : '💬 KiwiVerse staff want to interview you',
      description: newStatus === 'accepted' ? `Congratulations! Your staff application **#${id}** has been accepted.` : newStatus === 'rejected' ? `Your staff application **#${id}** has been reviewed and was not accepted this time.` : `Your staff application **#${id}** has moved to the interview stage. Staff will contact you with next steps.`,
      color: newStatus === 'accepted' ? 0x57f287 : newStatus === 'rejected' ? 0xed4245 : 0x5865f2,
    });
  }

  const originalEmbed = interaction.message.embeds[0];
  const embed = EmbedBuilder.from(originalEmbed)
    .setColor(newStatus === 'accepted' ? 0x57f287 : newStatus === 'rejected' ? 0xed4245 : 0x5865f2)
    .spliceFields(-1, 1, { name: 'Status', value: `${newStatus[0].toUpperCase()}${newStatus.slice(1)} by <@${interaction.user.id}>` });

  await interaction.update({ embeds: [embed], components: decisionButtons(id, newStatus !== 'interview') });
  if (newStatus === 'interview') return interaction.followUp({ content: `💬 Application #${id} moved to interview.`, ephemeral: true });
}

module.exports = {
  ensureSchema,
  buildPanel,
  startApplication,
  submitApplication,
  showStatus,
  listApplications,
  reviewApplication,
  handleDecision,
};
