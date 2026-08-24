'use strict';

require('dotenv').config();

const fs = require('fs');
const path = require('path');

const {
  ActionRowBuilder,
  ActivityType,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  MessageFlags,
  Partials,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
} = require('discord.js');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

const {
  DISCORD_TOKEN,
  CLIENT_ID,
  LOGS_CHANNEL_NAME = 'logs',
  WELCOME_CHANNEL_NAME = 'welcome',
  GUILD_ID = '',
  TRIAL_MOD_ROLE_ID = '',
  MOD_ROLE_ID = '',
  SR_MOD_ROLE_ID = '',
  ADMIN_ROLE_ID = '',
  VERIFIED_ROLE_NAME = 'Verified',
  GENERAL_CHANNEL_NAME = 'general',
} = process.env;

const DB_FILE = path.join(__dirname, 'database.sqlite');
const RAID_WINDOW_MS = 5000;
const RAID_JOIN_THRESHOLD = 10;
const RAID_LOCKDOWN_MS = 5 * 60 * 1000;
const XP_COOLDOWN_MS = 60000;
const MAX_ROBLOX_ACCOUNTS = 10;

const COLORS = {
  primary: 0x5865f2,
  success: 0x57f287,
  warning: 0xfee75c,
  danger: 0xed4245,
  ban: 0xed4245,
  kick: 0xe67e22,
  timeout: 0xfee75c,
};

const SLUR_FILTER = [
  'nigger',
  'nigga',
  'faggot',
  'kike',
  'tranny',
  'chink',
  'spic',
  'wetback',
  'retard',
];

const INVITE_PATTERN = /(?:discord\.gg|discord(?:app)?\.com\/invite)\/[^\s]+/i;
const LEET_MAP = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', '@': 'a', $: 's' };

let slurMatcher = null;

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildSlurMatcher() {
  const escaped = SLUR_FILTER.map(escapeRegex);
  slurMatcher = new RegExp(`\\b(?:${escaped.join('|')})\\b`, 'i');
}

function normalizeText(text) {
  return text.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

function containsForbiddenContent(rawText) {
  const text = normalizeText(rawText);
  if (INVITE_PATTERN.test(text)) return 'invite-link';
  const stripped = Array.from(text)
    .map((ch) => LEET_MAP[ch] ?? ch)
    .filter((ch) => /[a-z]/.test(ch))
    .join('');
  if ((slurMatcher && slurMatcher.test(text)) || SLUR_FILTER.some((word) => stripped.includes(word))) {
    return 'slur';
  }
  return null;
}

function clip(value, max = 900) {
  if (!value || !value.trim()) return '*none*';
  const flat = value.replace(/@/g, '@\u200b').trim();
  return flat.length > max ? `${flat.slice(0, max)}...` : flat;
}

const database = open({ filename: DB_FILE, driver: sqlite3.Database });

async function initDatabase() {
  const db = await database;
  await db.exec(`
    CREATE TABLE IF NOT EXISTS verified_users (
      discord_id TEXT PRIMARY KEY,
      roblox_accounts TEXT NOT NULL DEFAULT '[]',
      active_roblox_id TEXT
    );
    CREATE TABLE IF NOT EXISTS leveling (
      discord_id TEXT PRIMARY KEY,
      xp INTEGER NOT NULL DEFAULT 0,
      level INTEGER NOT NULL DEFAULT 0,
      last_message TIMESTAMP
    );
  `);
}

function safeParseArray(value) {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function getVerifiedUser(discordId) {
  const db = await database;
  return db.get('SELECT * FROM verified_users WHERE discord_id = ?', [discordId]);
}

async function addVerifiedRobloxAccount(discordId, robloxId) {
  const db = await database;
  const row = await getVerifiedUser(discordId);
  const accounts = row ? safeParseArray(row.roblox_accounts) : [];
  if (accounts.length >= MAX_ROBLOX_ACCOUNTS) return false;
  if (!accounts.includes(String(robloxId))) accounts.push(String(robloxId));
  await db.run(
    `INSERT INTO verified_users (discord_id, roblox_accounts, active_roblox_id)
     VALUES (?, ?, ?)
     ON CONFLICT(discord_id) DO UPDATE SET roblox_accounts = excluded.roblox_accounts`,
    [discordId, JSON.stringify(accounts), row?.active_roblox_id ?? String(robloxId)],
  );
  return true;
}

async function setActiveRobloxId(discordId, robloxId) {
  const db = await database;
  await db.run(
    `INSERT INTO verified_users (discord_id, roblox_accounts, active_roblox_id)
     VALUES (?, '[]', ?)
     ON CONFLICT(discord_id) DO UPDATE SET active_roblox_id = excluded.active_roblox_id`,
    [discordId, String(robloxId)],
  );
}

async function getLevelProfile(discordId) {
  const db = await database;
  const row = await db.get('SELECT * FROM leveling WHERE discord_id = ?', [discordId]);
  return row ?? { discord_id: discordId, xp: 0, level: 0, last_message: null };
}

async function recordMessageXp(message) {
  const now = Date.now();
  const profile = await getLevelProfile(message.author.id);
  if (profile.last_message && now - new Date(profile.last_message).getTime() < XP_COOLDOWN_MS) return null;
  const xp = profile.xp + Math.floor(Math.random() * 11) + 15;
  const level = Math.floor(Math.sqrt(xp) / 10);
  const leveledUp = level > profile.level;
  const db = await database;
  await db.run(
    `INSERT INTO leveling (discord_id, xp, level, last_message) VALUES (?, ?, ?, ?)
     ON CONFLICT(discord_id) DO UPDATE SET xp = excluded.xp, level = excluded.level, last_message = excluded.last_message`,
    [message.author.id, xp, level, new Date(now).toISOString()],
  );
  return leveledUp ? level : null;
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.GuildMember],
});

const raidJoinLog = new Map();
const raidLockdownTimers = new Map();

function findChannelByName(guild, name) {
  return guild.channels.cache.find((channel) => channel.name === name && channel.isTextBased()) ?? null;
}

function getLogsChannel(guild) {
  return findChannelByName(guild, LOGS_CHANNEL_NAME);
}

const STAFF_TIERS = [
  { label: 'Trial Mod', id: TRIAL_MOD_ROLE_ID },
  { label: 'Moderator', id: MOD_ROLE_ID },
  { label: 'Senior Moderator', id: SR_MOD_ROLE_ID },
  { label: 'Admin', id: ADMIN_ROLE_ID },
];

const COMMAND_MIN_TIER = {
  timeout: 0,
  kick: 1,
  ban: 2,
};

function getStaffTier(member) {
  if (!member || typeof member.permissions !== 'object' || !member.roles?.cache) return null;
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return STAFF_TIERS.length - 1;
  let highestTier = null;
  STAFF_TIERS.forEach((tier, index) => {
    if (tier.id && member.roles.cache.has(tier.id)) highestTier = index;
  });
  return highestTier;
}

const slashCommands = [
  new SlashCommandBuilder()
    .setName('ban')
    .setDescription('Permanently ban a member from KiwiVerse.')
    .addUserOption((option) =>
      option.setName('target').setDescription('The member to ban.').setRequired(true),
    )
    .addStringOption((option) =>
      option.setName('reason').setDescription('Why is this member being banned?'),
    )
    .addIntegerOption((option) =>
      option
        .setName('purge_days')
        .setDescription('Delete the target recent messages, in days.')
        .setMinValue(0)
        .setMaxValue(7),
    ),
  new SlashCommandBuilder()
    .setName('kick')
    .setDescription('Remove a member from KiwiVerse.')
    .addUserOption((option) =>
      option.setName('target').setDescription('The member to kick.').setRequired(true),
    )
    .addStringOption((option) =>
      option.setName('reason').setDescription('Why is this member being kicked?'),
    ),
  new SlashCommandBuilder()
    .setName('timeout')
    .setDescription('Temporarily mute a member in KiwiVerse.')
    .addUserOption((option) =>
      option.setName('target').setDescription('The member to timeout.').setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName('duration')
        .setDescription('How long should the timeout last?')
        .setRequired(true)
        .addChoices(
          { name: '60 seconds', value: '60000' },
          { name: '5 minutes', value: '300000' },
          { name: '10 minutes', value: '600000' },
          { name: '30 minutes', value: '1800000' },
          { name: '1 hour', value: '3600000' },
          { name: '6 hours', value: '21600000' },
          { name: '12 hours', value: '43200000' },
          { name: '1 day', value: '86400000' },
          { name: '1 week', value: '604800000' },
        ),
    )
    .addStringOption((option) =>
      option.setName('reason').setDescription('Why is this member being timed out?'),
    ),
].map((command) => command.toJSON());

async function registerSlashCommands() {
  const rest = new REST().setToken(DISCORD_TOKEN);
  const route = GUILD_ID
    ? Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID)
    : Routes.applicationCommands(CLIENT_ID);
  await rest.put(route, { body: slashCommands });
  console.log(`Registered ${slashCommands.length} slash commands.`);
}

client.once(Events.ClientReady, async () => {
  console.log(`KiwiVerse Mod online as ${client.user.tag}`);
  client.user.setActivity('over the KiwiVerse', { type: ActivityType.Watching });
  try {
    await registerSlashCommands();
  } catch (error) {
    console.error('Failed to register slash commands:', error);
  }
});

async function deliverWelcomeGate(member) {
  const channel = findChannelByName(member.guild, WELCOME_CHANNEL_NAME);
  if (!channel) return;
  const embed = new EmbedBuilder()
    .setColor(COLORS.primary)
    .setTitle('Welcome to the KiwiVerse Studio')
    .setDescription(
      `Hey ${member.user}, glad you made it in!\n\nRead through the studio rules below, then press **Accept Studio Rules** to unlock the rest of the server.`,
    )
    .addFields(
      { name: 'Rule 01 - Respect', value: 'Keep it civil. Zero tolerance for hate speech or harassment.' },
      { name: 'Rule 02 - No Spam', value: 'No spamming, raiding, or unsolicited advertising.' },
      { name: 'Rule 03 - Staff Calls', value: 'Follow direction from the KiwiVerse staff team at all times.' },
    )
    .setFooter({ text: 'KiwiVerse Moderation' })
    .setTimestamp();
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('accept_studio_rules')
      .setLabel('Accept Studio Rules')
      .setEmoji('✅')
      .setStyle(ButtonStyle.Success),
  );
  await channel.send({ content: `${member.user}`, embeds: [embed], components: [row] }).catch(() => null);
}

async function releaseRaidLockdown(guild) {
  raidLockdownTimers.delete(guild.id);
  const generalChannel = findChannelByName(guild, GENERAL_CHANNEL_NAME);
  const logsChannel = getLogsChannel(guild);
  if (!generalChannel) return;
  await generalChannel.permissionOverwrites
    .edit(guild.roles.everyone, { SendMessages: null }, { reason: 'Anti-raid lockdown expired.' })
    .catch(() => null);
  if (logsChannel) {
    const embed = new EmbedBuilder()
      .setColor(COLORS.success)
      .setTitle('🔓 Anti-Raid Lockdown Released')
      .setDescription(`${generalChannel} text permissions have been restored for standard members.`)
      .setTimestamp();
    await logsChannel.send({ embeds: [embed] }).catch(() => null);
  }
}

async function trackRaidBurst(member) {
  const guild = member.guild;
  const now = Date.now();
  const recentJoins = (raidJoinLog.get(guild.id) ?? []).filter(
    (timestamp) => now - timestamp <= RAID_WINDOW_MS,
  );
  recentJoins.push(now);
  raidJoinLog.set(guild.id, recentJoins);

  if (recentJoins.length < RAID_JOIN_THRESHOLD) return;

  const generalChannel = findChannelByName(guild, GENERAL_CHANNEL_NAME);
  if (!generalChannel) return;

  if (raidLockdownTimers.has(guild.id)) {
    clearTimeout(raidLockdownTimers.get(guild.id));
  } else {
    await generalChannel.permissionOverwrites
      .edit(
        guild.roles.everyone,
        { SendMessages: false },
        { reason: `Anti-raid lockdown: ${recentJoins.length} joins within ${RAID_WINDOW_MS / 1000}s.` },
      )
      .catch(() => null);

    const logsChannel = getLogsChannel(guild);
    if (logsChannel) {
      const embed = new EmbedBuilder()
        .setColor(COLORS.danger)
        .setTitle('🚨 Anti-Raid Lockdown Engaged')
        .setDescription(
          `Detected **${recentJoins.length} joins** inside a rolling ${RAID_WINDOW_MS / 1000}-second window.`,
        )
        .addFields(
          { name: 'Locked Channel', value: `${generalChannel}`, inline: true },
          { name: 'Standard Members', value: 'Send Messages denied', inline: true },
          { name: 'Auto Release', value: `${RAID_LOCKDOWN_MS / 60000} minutes`, inline: true },
        )
        .setTimestamp();
      await logsChannel.send({ embeds: [embed] }).catch(() => null);
    }
  }

  raidLockdownTimers.set(
    guild.id,
    setTimeout(() => releaseRaidLockdown(guild), RAID_LOCKDOWN_MS),
  );
}

client.on(Events.GuildMemberAdd, async (member) => {
  try {
    await deliverWelcomeGate(member);
  } catch (error) {
    console.error('Welcome gate failure:', error);
  }
  try {
    await trackRaidBurst(member);
  } catch (error) {
    console.error('Anti-raid tracker failure:', error);
  }
});

async function reportFilterViolation(message, violation) {
  const logsChannel = getLogsChannel(message.guild);
  if (!logsChannel) return;
  const labels = {
    slur: 'Prohibited language detected',
    'invite-link': 'Third-party Discord invite link',
  };
  const embed = new EmbedBuilder()
    .setColor(COLORS.danger)
    .setTitle('🛑 Content Filter Triggered')
    .setDescription(`Intercepted and deleted a message from ${message.channel}.`)
    .addFields(
      { name: 'Member', value: `${message.author.tag} (${message.author.id})`, inline: true },
      { name: 'Channel', value: `${message.channel}`, inline: true },
      { name: 'Violation Type', value: labels[violation] ?? violation, inline: true },
      { name: 'Intercepted Content', value: clip(message.content) },
    )
    .setFooter({ text: 'Deleted automatically by KiwiVerse content filters.' })
    .setTimestamp();
  await logsChannel.send({ embeds: [embed] }).catch(() => null);
}

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot || !message.guild) return;

  const violation = containsForbiddenContent(message.content ?? '');
  if (violation) {
    await message.delete().catch(() => null);
    await reportFilterViolation(message, violation);
    return;
  }

  const newLevel = await recordMessageXp(message).catch(() => null);
  if (newLevel !== null && newLevel !== undefined) {
    await message.react('🎉').catch(() => null);
  }
});

async function handleAcceptRules(interaction) {
  const role =
    interaction.guild.roles.cache.find((entry) => entry.name === VERIFIED_ROLE_NAME) ?? null;
  if (!role) {
    await interaction.reply({
      content: `⚠️ I could not find a **${VERIFIED_ROLE_NAME}** role. Please ask staff to create one.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (interaction.member.roles.cache.has(role.id)) {
    await interaction.reply({
      content: '✅ You are already verified. Enjoy your stay in the KiwiVerse!',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  await interaction.member.roles.add(role, 'Accepted the Studio Rules.');
  await interaction.reply({
    content: `✅ Rules accepted! You have been granted the ${role} role. Welcome aboard.`,
    flags: MessageFlags.Ephemeral,
  });
}

async function logModerationAction(interaction, config) {
  const logsChannel = getLogsChannel(interaction.guild);
  if (!logsChannel) return;
  const imagePath = path.join(__dirname, config.thumbnailFile);
  const attachment = fs.existsSync(imagePath)
    ? new AttachmentBuilder(imagePath, { name: config.thumbnailFile })
    : null;
  const memberTier = getStaffTier(interaction.member);
  const embed = new EmbedBuilder()
    .setColor(config.color)
    .setAuthor({
      name: 'KiwiVerse Moderation Log',
      iconURL: interaction.guild.iconURL() ?? undefined,
    })
    .setTitle(`📋 ${config.action}`)
    .setThumbnail(`attachment://${config.thumbnailFile}`)
    .addFields(
      { name: 'Target', value: `${config.target.tag} (${config.target.id})`, inline: true },
      { name: 'Moderator', value: interaction.user.tag, inline: true },
      {
        name: 'Staff Rank',
        value: memberTier !== null ? STAFF_TIERS[memberTier].label : 'Unknown',
        inline: true,
      },
      ...(config.extraFields ?? []),
      { name: 'Reason', value: clip(config.reason, 1000) },
    )
    .setFooter({ text: `Actioned by ${interaction.user.tag}` })
    .setTimestamp();
  const payload = attachment ? { embeds: [embed], files: [attachment] } : { embeds: [embed] };
  await logsChannel.send(payload).catch(() => null);
}

async function resolveTargetMember(interaction) {
  const targetUser = interaction.options.getUser('target', true);
  return interaction.guild.members.fetch(targetUser.id).catch(() => null);
}

function moderationDenialReason(interaction, targetMember) {
  if (!targetMember) return 'That user is not currently in this server.';
  if (targetMember.id === interaction.user.id) return 'You cannot moderate yourself.';
  if (targetMember.id === client.user.id) return 'I am not going to moderate myself.';
  if (targetMember.id === interaction.guild.ownerId) return 'The server owner cannot be moderated.';
  if (
    interaction.guild.ownerId !== interaction.user.id &&
    interaction.member.roles.highest.comparePositionTo(targetMember.roles.highest) <= 0
  ) {
    return 'You cannot moderate someone with an equal or higher role than yours.';
  }
  if (!targetMember.manageable) return 'My highest role is below theirs, so I cannot act on this member.';
  return null;
}

async function executeBan(interaction) {
  const targetUser = interaction.options.getUser('target', true);
  const reason = interaction.options.getString('reason') ?? 'No reason provided.';
  const purgeDays = interaction.options.getInteger('purge_days') ?? 0;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const targetMember = await resolveTargetMember(interaction);
  const denial = targetMember ? moderationDenialReason(interaction, targetMember) : null;
  if (denial) {
    await interaction.editReply({ content: `⛔ ${denial}` });
    return;
  }

  await logModerationAction(interaction, {
    action: 'Ban Issued',
    thumbnailFile: 'ban.png',
    color: COLORS.ban,
    target: targetUser,
    reason,
    extraFields: [{ name: 'Message Purge', value: `${purgeDays} day(s)`, inline: true }],
  });

  await interaction.guild.members.ban(targetUser.id, {
    deleteMessageSeconds: purgeDays * 86400,
    reason: `${interaction.user.tag} | ${reason}`,
  });

  await interaction.editReply({ content: `🔨 Banned **${targetUser.tag}** from the server.` });
}

async function executeKick(interaction) {
  const targetUser = interaction.options.getUser('target', true);
  const reason = interaction.options.getString('reason') ?? 'No reason provided.';
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const targetMember = await resolveTargetMember(interaction);
  const denial = moderationDenialReason(interaction, targetMember);
  if (denial) {
    await interaction.editReply({ content: `⛔ ${denial}` });
    return;
  }

  await logModerationAction(interaction, {
    action: 'Kick Issued',
    thumbnailFile: 'kick.png',
    color: COLORS.kick,
    target: targetUser,
    reason,
  });

  await targetMember.kick(`${interaction.user.tag} | ${reason}`);

  await interaction.editReply({ content: `👢 Kicked **${targetUser.tag}** from the server.` });
}

async function executeTimeout(interaction) {
  const targetUser = interaction.options.getUser('target', true);
  const durationMs = Number.parseInt(interaction.options.getString('duration', true), 10);
  const reason = interaction.options.getString('reason') ?? 'No reason provided.';
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const targetMember = await resolveTargetMember(interaction);
  const denial = moderationDenialReason(interaction, targetMember);
  if (denial) {
    await interaction.editReply({ content: `⛔ ${denial}` });
    return;
  }

  await logModerationAction(interaction, {
    action: 'Timeout Issued',
    thumbnailFile: 'timeout.png',
    color: COLORS.timeout,
    target: targetUser,
    reason,
    extraFields: [{ name: 'Duration', value: `<t:${Math.floor((Date.now() + durationMs) / 1000)}:R>`, inline: true }],
  });

  await targetMember.timeout(durationMs, `${interaction.user.tag} | ${reason}`);

  await interaction.editReply({ content: `⏳ Timed out **${targetUser.tag}** for <t:${Math.floor((Date.now() + durationMs) / 1000)}:R>.` });
}

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      const requiredTier = COMMAND_MIN_TIER[interaction.commandName];
      if (requiredTier !== undefined) {
        const memberTier = getStaffTier(interaction.member);
        if (memberTier === null || memberTier < requiredTier) {
          await interaction.reply({
            content: `⛔ This command requires the **${STAFF_TIERS[requiredTier].label}** rank or higher.`,
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
      }
      switch (interaction.commandName) {
        case 'ban':
          await executeBan(interaction);
          break;
        case 'kick':
          await executeKick(interaction);
          break;
        case 'timeout':
          await executeTimeout(interaction);
          break;
        default:
          break;
      }
      return;
    }

    if (interaction.isButton() && interaction.customId === 'accept_studio_rules') {
      await handleAcceptRules(interaction);
    }
  } catch (error) {
    console.error('Interaction failure:', error);
    const payload = {
      content: '⚠️ Something went wrong while processing that request.',
      flags: MessageFlags.Ephemeral,
    };
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp(payload).catch(() => null);
    } else {
      await interaction.reply(payload).catch(() => null);
    }
  }
});

client.on(Events.MessageDelete, async (message) => {
  if (message.partial) {
    try {
      await message.fetch();
    } catch {
      return;
    }
  }
  if (!message.guild || message.author?.bot) return;
  const logsChannel = getLogsChannel(message.guild);
  if (!logsChannel) return;
  const embed = new EmbedBuilder()
    .setColor(COLORS.warning)
    .setTitle('🗑️ Message Deleted')
    .addFields(
      {
        name: 'Author',
        value: `${message.author?.tag ?? 'Unknown'} (${message.author?.id ?? 'unknown'})`,
        inline: true,
      },
      { name: 'Channel', value: `${message.channel}`, inline: true },
      { name: 'Content', value: clip(message.content) },
    );
  if (message.attachments?.size) {
    embed.addFields({
      name: 'Attachments',
      value: clip(message.attachments.map((attachment) => attachment.name).join(', '), 500),
    });
  }
  embed.setTimestamp();
  await logsChannel.send({ embeds: [embed] }).catch(() => null);
});

client.on(Events.MessageUpdate, async (oldMessage, newMessage) => {
  if (newMessage.partial) {
    try {
      await newMessage.fetch();
    } catch {
      return;
    }
  }
  if (!newMessage.guild || newMessage.author?.bot) return;
  const before = oldMessage.partial ? null : oldMessage.content;
  if (before !== null && before === newMessage.content) return;
  const logsChannel = getLogsChannel(newMessage.guild);
  if (!logsChannel) return;
  const embed = new EmbedBuilder()
    .setColor(COLORS.primary)
    .setTitle('✏️ Message Edited')
    .addFields(
      { name: 'Author', value: `${newMessage.author.tag} (${newMessage.author.id})`, inline: true },
      { name: 'Channel', value: `${newMessage.channel}`, inline: true },
      { name: 'Before', value: before === null ? '*original message was not cached*' : clip(before) },
      { name: 'After', value: clip(newMessage.content) },
    )
    .setTimestamp();
  await logsChannel.send({ embeds: [embed] }).catch(() => null);
});

process.on('unhandledRejection', (error) => {
  console.error('Unhandled promise rejection:', error);
});

buildSlurMatcher();

(async () => {
  if (!DISCORD_TOKEN || DISCORD_TOKEN.startsWith('paste-your') || !CLIENT_ID || CLIENT_ID.startsWith('paste-your')) {
    console.error('Missing configuration: fill DISCORD_TOKEN and CLIENT_ID in the .env file first.');
    process.exit(1);
  }
  await initDatabase();
  console.log(`SQLite storage ready at ${DB_FILE}`);
  await client.login(DISCORD_TOKEN);
})();
