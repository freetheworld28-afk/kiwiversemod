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

const DEFAULT_FORMS = [
  {
    slug: 'staff',
    name: 'Staff',
    description: 'Apply to join the KiwiVerse moderation/staff team.',
    questions: [
      'How old are you?',
      'What is your timezone / country?',
      'What previous moderation or staff experience do you have?',
      'Why do you want to join KiwiVerse staff?',
      'How active can you be each week?',
    ],
  },
  {
    slug: 'game-tester',
    name: 'Game Tester',
    description: 'Apply to test KiwiVerse Roblox updates before release.',
    questions: [
      'What is your Roblox username?',
      'What devices can you test on?',
      'How often can you test new builds?',
      'Describe a useful bug report you would submit.',
      'Why do you want to become a KiwiVerse tester?',
    ],
  },
];

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

async function ensureSchema(database, guildId = null) {
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

    CREATE TABLE IF NOT EXISTS application_forms (
      guild_id TEXT NOT NULL,
      slug TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      questions TEXT NOT NULL,
      accept_role_id TEXT,
      review_channel_id TEXT,
      enabled INTEGER DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (guild_id, slug)
    );

    CREATE INDEX IF NOT EXISTS idx_applications_guild_status ON applications(guild_id, status);
  `);

  if (guildId) {
    for (const form of DEFAULT_FORMS) {
      await db.run(
        `INSERT OR IGNORE INTO application_forms (guild_id, slug, name, description, questions, enabled)
         VALUES (?, ?, ?, ?, ?, 1)`,
        guildId,
        form.slug,
        form.name,
        form.description,
        JSON.stringify(form.questions),
      );
    }
  }
}

function reviewerRoleIds() {
  return [process.env.SR_MOD_ROLE_ID, process.env.ADMIN_ROLE_ID, process.env.APPLICATION_REVIEWER_ROLE_ID].filter(Boolean);
}

function isReviewer(member) {
  if (!member) return false;
  if (member.permissions?.has(PermissionFlagsBits.ManageGuild)) return true;
  return reviewerRoleIds().some((id) => member.roles?.cache?.has(id));
}

async function getForm(database, guildId, slug = 'staff') {
  await ensureSchema(database, guildId);
  const db = await database;
  const row = await db.get(
    'SELECT * FROM application_forms WHERE guild_id = ? AND slug = ? AND enabled = 1',
    guildId,
    slugify(slug) || 'staff',
  );
  if (!row) return null;
  let questions = [];
  try { questions = JSON.parse(row.questions || '[]'); } catch { questions = []; }
  return { ...row, questions: questions.slice(0, 5) };
}

async function listForms(database, guildId) {
  await ensureSchema(database, guildId);
  const db = await database;
  return db.all('SELECT slug, name, description, accept_role_id, review_channel_id, enabled FROM application_forms WHERE guild_id = ? ORDER BY name', guildId);
}

function buildPanel(form) {
  const embed = new EmbedBuilder()
    .setColor(0x8b5cf6)
    .setTitle(`📝 KiwiVerse ${form.name} Applications`)
    .setDescription(form.description || `Apply for ${form.name}. Staff will review your answers and DM you when a decision is made.`)
    .addFields({ name: 'Before applying', value: 'Make sure your DMs are open so KiwiVerse can send you the result.' })
    .setFooter({ text: `Application type: ${form.slug} • One active application per type.` });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`apply_start:${form.slug}`).setLabel('Apply').setEmoji('📝').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('apply_status').setLabel('My Application').setEmoji('📋').setStyle(ButtonStyle.Secondary),
  );
  return { embeds: [embed], components: [row] };
}

function buildApplicationModal(form) {
  const modal = new ModalBuilder()
    .setCustomId(`apply_submit:${form.slug}`)
    .setTitle(`${form.name} Application`.slice(0, 45));

  const questions = form.questions.length ? form.questions : ['Why are you applying?'];
  questions.slice(0, 5).forEach((question, index) => {
    const input = new TextInputBuilder()
      .setCustomId(`q${index}`)
      .setLabel(String(question).slice(0, 45))
      .setStyle(index >= 2 ? TextInputStyle.Paragraph : TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(index >= 2 ? 1000 : 200);
    modal.addComponents(new ActionRowBuilder().addComponents(input));
  });
  return modal;
}

function buildFormCreatorModal(reviewChannelId = '') {
  const modal = new ModalBuilder().setCustomId(`apply_form_create:${reviewChannelId || 'none'}`).setTitle('Create Application Form');
  const name = new TextInputBuilder().setCustomId('name').setLabel('Form name (e.g. Game Tester)').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(40);
  const slug = new TextInputBuilder().setCustomId('slug').setLabel('Short ID (e.g. game-tester)').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(40);
  const description = new TextInputBuilder().setCustomId('description').setLabel('Description').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(500);
  const questions = new TextInputBuilder().setCustomId('questions').setLabel('Questions - one per line (max 5)').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(1500);
  const role = new TextInputBuilder().setCustomId('accept_role').setLabel('Role ID to give when accepted (optional)').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(30);
  modal.addComponents(
    new ActionRowBuilder().addComponents(name),
    new ActionRowBuilder().addComponents(slug),
    new ActionRowBuilder().addComponents(description),
    new ActionRowBuilder().addComponents(questions),
    new ActionRowBuilder().addComponents(role),
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

async function startApplication(interaction, database, slug = 'staff') {
  const form = await getForm(database, interaction.guild.id, slug);
  if (!form) return interaction.reply({ content: `Application form **${slug}** was not found or is disabled.`, ephemeral: true });
  const db = await database;
  const pending = await db.get(
    "SELECT id FROM applications WHERE guild_id = ? AND user_id = ? AND application_type = ? AND status IN ('pending','interview') ORDER BY id DESC LIMIT 1",
    interaction.guild.id,
    interaction.user.id,
    form.slug,
  );
  if (pending) return interaction.reply({ content: `You already have an active ${form.name} application (#${pending.id}).`, ephemeral: true });
  return interaction.showModal(buildApplicationModal(form));
}

async function submitApplication(interaction, database, slug = 'staff') {
  const form = await getForm(database, interaction.guild.id, slug);
  if (!form) return interaction.reply({ content: 'That application form no longer exists.', ephemeral: true });
  const db = await database;

  const answers = {};
  form.questions.forEach((question, index) => {
    answers[question] = interaction.fields.getTextInputValue(`q${index}`);
  });

  const existing = await db.get(
    "SELECT id FROM applications WHERE guild_id = ? AND user_id = ? AND application_type = ? AND status IN ('pending','interview') ORDER BY id DESC LIMIT 1",
    interaction.guild.id,
    interaction.user.id,
    form.slug,
  );
  if (existing) return interaction.reply({ content: `You already have an active ${form.name} application (#${existing.id}).`, ephemeral: true });

  const result = await db.run(
    `INSERT INTO applications (guild_id, user_id, username, application_type, answers, status)
     VALUES (?, ?, ?, ?, ?, 'pending')`,
    interaction.guild.id,
    interaction.user.id,
    interaction.user.username,
    form.slug,
    JSON.stringify(answers),
  );

  let reviewChannel = null;
  const configuredReviewId = form.review_channel_id || process.env.APPLICATION_REVIEW_CHANNEL_ID;
  if (configuredReviewId) reviewChannel = await interaction.guild.channels.fetch(configuredReviewId).catch(() => null);
  if (!reviewChannel?.isTextBased()) {
    reviewChannel = interaction.guild.channels.cache.find((ch) => ch.name === 'staff-applications' && ch.isTextBased()) || null;
  }
  if (!reviewChannel) {
    reviewChannel = await interaction.guild.channels.create({
      name: 'staff-applications',
      type: ChannelType.GuildText,
      permissionOverwrites: [
        { id: interaction.guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
        { id: interaction.client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
        ...reviewerRoleIds().map((id) => ({ id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] })),
      ],
      reason: 'KiwiVerse application review channel',
    }).catch(() => null);
  }

  const embed = new EmbedBuilder()
    .setColor(0xfee75c)
    .setTitle(`📝 ${form.name} Application #${result.lastID}`)
    .setDescription(`Applicant: <@${interaction.user.id}> (${interaction.user.tag})`)
    .addFields(...Object.entries(answers).map(([question, answer]) => ({ name: question.slice(0, 256), value: String(answer).slice(0, 1024) })))
    .addFields({ name: 'Status', value: 'Pending review' })
    .setThumbnail(interaction.user.displayAvatarURL({ size: 256 }))
    .setTimestamp();

  if (reviewChannel?.isTextBased()) {
    const reviewMessage = await reviewChannel.send({ embeds: [embed], components: decisionButtons(result.lastID) });
    await db.run('UPDATE applications SET review_channel_id = ?, review_message_id = ? WHERE id = ?', reviewChannel.id, reviewMessage.id, result.lastID);
  }

  await notifyUser(interaction.user, {
    title: `📝 KiwiVerse ${form.name} application received`,
    description: `Your application **#${result.lastID}** has been submitted and is waiting for review.`,
    color: 0x8b5cf6,
  });
  return interaction.reply({ content: `✅ ${form.name} application #${result.lastID} submitted successfully.`, ephemeral: true });
}

async function createForm(interaction, database, reviewChannelId = '') {
  if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) return interaction.reply({ content: '⛔ You need Manage Server to create application forms.', ephemeral: true });
  await ensureSchema(database, interaction.guild.id);
  const db = await database;
  const name = interaction.fields.getTextInputValue('name').trim();
  const requestedSlug = interaction.fields.getTextInputValue('slug').trim();
  const slug = slugify(requestedSlug || name);
  const description = interaction.fields.getTextInputValue('description').trim();
  const questions = interaction.fields.getTextInputValue('questions').split('\n').map((q) => q.trim()).filter(Boolean).slice(0, 5);
  const acceptRoleId = interaction.fields.getTextInputValue('accept_role').trim() || null;
  if (!slug || !questions.length) return interaction.reply({ content: 'A form needs a valid name/ID and at least one question.', ephemeral: true });

  await db.run(
    `INSERT INTO application_forms (guild_id, slug, name, description, questions, accept_role_id, review_channel_id, enabled)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1)
     ON CONFLICT(guild_id, slug) DO UPDATE SET name=excluded.name, description=excluded.description, questions=excluded.questions, accept_role_id=excluded.accept_role_id, review_channel_id=excluded.review_channel_id, enabled=1`,
    interaction.guild.id,
    slug,
    name,
    description,
    JSON.stringify(questions),
    acceptRoleId,
    reviewChannelId && reviewChannelId !== 'none' ? reviewChannelId : null,
  );
  return interaction.reply({ content: `✅ Application form **${name}** created with ID \`${slug}\`. Use \`/apply panel form:${slug}\` to post it.`, ephemeral: true });
}

async function deleteForm(interaction, database, slug) {
  if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) return interaction.reply({ content: '⛔ You need Manage Server to delete application forms.', ephemeral: true });
  await ensureSchema(database, interaction.guild.id);
  const db = await database;
  const result = await db.run('DELETE FROM application_forms WHERE guild_id = ? AND slug = ?', interaction.guild.id, slugify(slug));
  return interaction.reply({ content: result.changes ? `🗑️ Deleted form \`${slugify(slug)}\`.` : 'Form not found.', ephemeral: true });
}

async function showForms(interaction, database) {
  const forms = await listForms(database, interaction.guild.id);
  const lines = forms.map((f) => `• **${f.name}** — \`${f.slug}\`${f.accept_role_id ? ` • accepted role <@&${f.accept_role_id}>` : ''}`).join('\n') || 'No application forms configured.';
  return interaction.reply({ embeds: [new EmbedBuilder().setColor(0x8b5cf6).setTitle('📝 KiwiVerse Application Forms').setDescription(lines)] });
}

async function showStatus(interaction, database) {
  await ensureSchema(database, interaction.guild.id);
  const db = await database;
  const app = await db.get(
    'SELECT id, application_type, status, reviewed_by, review_note, created_at, reviewed_at FROM applications WHERE guild_id = ? AND user_id = ? ORDER BY id DESC LIMIT 1',
    interaction.guild.id,
    interaction.user.id,
  );
  if (!app) return interaction.reply({ content: 'You have not submitted an application yet.', ephemeral: true });
  const label = app.status === 'accepted' ? '✅ Accepted' : app.status === 'rejected' ? '❌ Rejected' : app.status === 'interview' ? '💬 Interview requested' : '⏳ Pending';
  const embed = new EmbedBuilder().setColor(app.status === 'accepted' ? 0x57f287 : app.status === 'rejected' ? 0xed4245 : 0xfee75c).setTitle(`Application #${app.id}`).addFields(
    { name: 'Type', value: app.application_type || 'staff', inline: true },
    { name: 'Status', value: label, inline: true },
    { name: 'Submitted', value: `<t:${Math.floor(new Date(app.created_at).getTime() / 1000)}:R>` },
  );
  if (app.reviewed_by) embed.addFields({ name: 'Reviewed by', value: `<@${app.reviewed_by}>` });
  if (app.review_note) embed.addFields({ name: 'Staff note', value: app.review_note });
  return interaction.reply({ embeds: [embed], ephemeral: true });
}

async function listApplications(interaction, database) {
  if (!isReviewer(interaction.member)) return interaction.reply({ content: 'Only authorized staff can list applications.', ephemeral: true });
  await ensureSchema(database, interaction.guild.id);
  const db = await database;
  const rows = await db.all("SELECT id, user_id, application_type, status, created_at FROM applications WHERE guild_id = ? ORDER BY id DESC LIMIT 20", interaction.guild.id);
  const text = rows.length ? rows.map((a) => `**#${a.id}** • ${a.application_type} • <@${a.user_id}> • **${a.status}** • <t:${Math.floor(new Date(a.created_at).getTime()/1000)}:R>`).join('\n') : 'No applications yet.';
  return interaction.reply({ embeds: [new EmbedBuilder().setColor(0x8b5cf6).setTitle('📝 Recent Applications').setDescription(text)], ephemeral: true });
}

async function reviewApplication(interaction, database, id) {
  if (!isReviewer(interaction.member)) return interaction.reply({ content: 'Only authorized staff can review applications.', ephemeral: true });
  await ensureSchema(database, interaction.guild.id);
  const db = await database;
  const app = await db.get('SELECT * FROM applications WHERE id = ? AND guild_id = ?', id, interaction.guild.id);
  if (!app) return interaction.reply({ content: 'Application not found.', ephemeral: true });
  let answers = {};
  try { answers = JSON.parse(app.answers || '{}'); } catch { answers = {}; }
  const embed = new EmbedBuilder().setColor(app.status === 'pending' ? 0xfee75c : 0x8b5cf6).setTitle(`📝 ${app.application_type} Application #${app.id}`).setDescription(`Applicant: <@${app.user_id}>`).addFields(
    ...Object.entries(answers).map(([q, a]) => ({ name: q.slice(0, 256), value: String(a).slice(0, 1024) })),
    { name: 'Status', value: app.status },
  );
  return interaction.reply({ embeds: [embed], components: decisionButtons(app.id, !['pending', 'interview'].includes(app.status)), ephemeral: true });
}

async function handleDecision(interaction, database) {
  if (!isReviewer(interaction.member)) return interaction.reply({ content: 'Only authorized staff can review applications.', ephemeral: true });
  await ensureSchema(database, interaction.guild.id);
  const db = await database;
  const [action, idText] = interaction.customId.split(':');
  const id = Number(idText);
  if (!Number.isInteger(id)) return interaction.reply({ content: 'Invalid application ID.', ephemeral: true });
  const app = await db.get('SELECT * FROM applications WHERE id = ? AND guild_id = ?', id, interaction.guild.id);
  if (!app) return interaction.reply({ content: 'Application not found.', ephemeral: true });
  if (!['pending', 'interview'].includes(app.status)) return interaction.reply({ content: `Application #${id} has already been ${app.status}.`, ephemeral: true });

  const newStatus = action === 'apply_accept' ? 'accepted' : action === 'apply_reject' ? 'rejected' : 'interview';
  await db.run('UPDATE applications SET status = ?, reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP WHERE id = ?', newStatus, interaction.user.id, id);

  if (newStatus === 'accepted') {
    const form = await getForm(database, interaction.guild.id, app.application_type);
    if (form?.accept_role_id) {
      const member = await interaction.guild.members.fetch(app.user_id).catch(() => null);
      if (member) await member.roles.add(form.accept_role_id, `Accepted ${form.name} application #${id}`).catch(() => null);
    }
  }

  const applicant = await interaction.client.users.fetch(app.user_id).catch(() => null);
  const title = newStatus === 'accepted' ? '✅ Your KiwiVerse application was accepted' : newStatus === 'rejected' ? '❌ Your KiwiVerse application was not accepted' : '💬 KiwiVerse staff want to interview you';
  const description = newStatus === 'accepted' ? `Congratulations! Your **${app.application_type}** application #${id} has been accepted.` : newStatus === 'rejected' ? `Your **${app.application_type}** application #${id} was not accepted this time.` : `Your application #${id} has moved to the interview stage.`;
  if (applicant) await notifyUser(applicant, { title, description, color: newStatus === 'accepted' ? 0x57f287 : newStatus === 'rejected' ? 0xed4245 : 0x5865f2 });

  const originalEmbed = interaction.message.embeds[0];
  const embed = originalEmbed ? EmbedBuilder.from(originalEmbed).setColor(newStatus === 'accepted' ? 0x57f287 : newStatus === 'rejected' ? 0xed4245 : 0x5865f2) : new EmbedBuilder().setTitle(`Application #${id}`);
  const fields = embed.data.fields || [];
  const statusIndex = fields.findIndex((f) => f.name === 'Status');
  if (statusIndex >= 0) embed.spliceFields(statusIndex, 1, { name: 'Status', value: `${newStatus[0].toUpperCase()}${newStatus.slice(1)} by <@${interaction.user.id}>` });
  else embed.addFields({ name: 'Status', value: `${newStatus[0].toUpperCase()}${newStatus.slice(1)} by <@${interaction.user.id}>` });

  await interaction.update({ embeds: [embed], components: decisionButtons(id, newStatus !== 'interview') });
  if (newStatus === 'interview') return interaction.followUp({ content: `💬 Application #${id} moved to interview.`, ephemeral: true });
}

module.exports = {
  ensureSchema,
  getForm,
  listForms,
  buildPanel,
  buildFormCreatorModal,
  startApplication,
  submitApplication,
  createForm,
  deleteForm,
  showForms,
  showStatus,
  listApplications,
  reviewApplication,
  handleDecision,
};
