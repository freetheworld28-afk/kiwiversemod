'use strict';

const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  EmbedBuilder,
  AuditLogEvent,
  MessageFlags,
} = require('discord.js');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseTimestamp(value) {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

async function getBotCreatedInviteCodes(guild, maliciousBotId = null) {
  const codes = new Set();

  const currentInvites = await guild.invites.fetch().catch(() => null);
  if (currentInvites) {
    for (const invite of currentInvites.values()) {
      const inviter = invite.inviter;
      if (!inviter?.bot) continue;
      if (maliciousBotId && inviter.id !== maliciousBotId) continue;
      codes.add(String(invite.code));
    }
  }

  const logs = await guild.fetchAuditLogs({ type: AuditLogEvent.InviteCreate, limit: 100 }).catch(() => null);
  if (logs) {
    for (const entry of logs.entries.values()) {
      const executor = entry.executor;
      if (executor?.bot !== true) continue;
      if (maliciousBotId && entry.executorId !== maliciousBotId) continue;
      const code = entry.target?.code || entry.changes?.find?.((c) => c.key === 'code')?.new;
      if (code) codes.add(String(code));
    }
  }

  return codes;
}

async function candidatesFromTrackedInvites(database, guildId, codes) {
  if (!codes.size) return [];
  const db = await database;
  const placeholders = Array.from(codes).map(() => '?').join(',');
  return db.all(
    `SELECT joiner_id AS userId, invite_code AS inviteCode, joined_at AS joinedAt
     FROM invite_joins
     WHERE guild_id = ? AND invite_code IN (${placeholders}) AND left_at IS NULL`,
    guildId,
    ...codes,
  );
}

async function candidatesFromWindow(guild, startMs, endMs, onlyEveryone) {
  await guild.members.fetch();
  return guild.members.cache
    .filter((member) => {
      if (member.user.bot) return false;
      if (!member.joinedTimestamp) return false;
      if (member.joinedTimestamp < startMs || member.joinedTimestamp > endMs) return false;
      if (onlyEveryone && member.roles.cache.size !== 1) return false;
      return true;
    })
    .map((member) => ({
      userId: member.id,
      joinedAt: new Date(member.joinedTimestamp).toISOString(),
      inviteCode: null,
      roleCount: member.roles.cache.size,
    }));
}

async function buildCandidateSet(interaction, database) {
  const maliciousBotId = interaction.options.getString('bot_id');
  const anyBot = interaction.options.getBoolean('any_bot') ?? false;
  const onlyEveryone = interaction.options.getBoolean('only_everyone') ?? true;
  const start = interaction.options.getString('start');
  const end = interaction.options.getString('end');

  const codes = (anyBot || maliciousBotId)
    ? await getBotCreatedInviteCodes(interaction.guild, anyBot ? null : maliciousBotId)
    : new Set();

  let candidates = await candidatesFromTrackedInvites(database, interaction.guild.id, codes);
  let mode = codes.size && candidates.length ? (anyBot ? 'all_bot_invites' : 'tracked_invites') : 'time_window';

  if (!candidates.length) {
    const startMs = parseTimestamp(start);
    const endMs = parseTimestamp(end);
    if (!startMs || !endMs || startMs > endMs) {
      const scope = anyBot
        ? 'bot-created invite codes were found, but KiwiVerse has no stored member-to-invite attribution for those historical joins'
        : 'no tracked raid invites were found';
      return {
        error: `${scope}. Discord does not expose a historical member→invite lookup after the fact. Provide a safe fallback \`start\` and \`end\` window.`,
        codes: Array.from(codes),
      };
    }
    candidates = await candidatesFromWindow(interaction.guild, startMs, endMs, onlyEveryone);
  }

  const unique = new Map();
  for (const row of candidates) {
    if (row.userId === interaction.guild.ownerId || row.userId === interaction.user.id) continue;
    const member = await interaction.guild.members.fetch(row.userId).catch(() => null);
    if (!member || !member.kickable) continue;
    unique.set(row.userId, { ...row, member });
  }

  return { mode, codes: Array.from(codes), candidates: Array.from(unique.values()), onlyEveryone };
}

function addCommonOptions(sub) {
  return sub
    .addBooleanOption((opt) => opt
      .setName('any_bot')
      .setDescription('Match joins through invites created by ANY bot account'))
    .addStringOption((opt) => opt
      .setName('bot_id')
      .setDescription('Optional: only invites created by this specific bot ID'))
    .addStringOption((opt) => opt
      .setName('start')
      .setDescription('Fallback raid start, ISO format'))
    .addStringOption((opt) => opt
      .setName('end')
      .setDescription('Fallback raid end, ISO format'))
    .addBooleanOption((opt) => opt
      .setName('only_everyone')
      .setDescription('Fallback: only match members with no roles besides @everyone (default true)'));
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('raidcleanup')
    .setDescription('Preview or remove accounts linked to a bot-driven raid')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand((sub) => addCommonOptions(sub
      .setName('preview')
      .setDescription('Preview accounts that would be removed')))
    .addSubcommand((sub) => {
      sub
        .setName('execute')
        .setDescription('Bulk kick the previewed raid accounts')
        .addStringOption((opt) => opt
          .setName('confirm')
          .setDescription('Type KICK to confirm mass removal')
          .setRequired(true));
      return addCommonOptions(sub);
    }),

  async execute(interaction, client, database) {
    if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
      return interaction.reply({ content: '⛔ Administrator permission is required for raid cleanup.', flags: MessageFlags.Ephemeral });
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const result = await buildCandidateSet(interaction, database);
    if (result.error) {
      const codeNote = result.codes?.length ? `\n🤖 Bot-created invite codes still visible: **${result.codes.length}**` : '';
      return interaction.editReply({ content: `⚠️ ${result.error}${codeNote}` });
    }

    const sample = result.candidates.slice(0, 20)
      .map((c) => `• <@${c.userId}>${c.inviteCode ? ` via \`${c.inviteCode}\`` : ''} • roles: ${Math.max(0, (c.member?.roles?.cache?.size || c.roleCount || 1) - 1)}`)
      .join('\n') || 'None';

    const modeLabel = result.mode === 'all_bot_invites'
      ? 'Tracked joins through ANY bot-created invite'
      : result.mode === 'tracked_invites'
        ? 'Tracked invite attribution for selected bot'
        : `Join-time fallback (${result.onlyEveryone ? '@everyone-only accounts' : 'all kickable human accounts in window'})`;

    if (interaction.options.getSubcommand() === 'preview') {
      const embed = new EmbedBuilder()
        .setColor(0xfee75c)
        .setTitle('🧹 Raid Cleanup Preview')
        .setDescription(`**Mode:** ${modeLabel}\n**Candidates:** ${result.candidates.length}\n**Bot-created invite codes found:** ${result.codes.length}`)
        .addFields({ name: 'First candidates', value: sample.slice(0, 1024) })
        .setFooter({ text: 'Nothing has been kicked. Review the count and sample before running execute.' })
        .setTimestamp();
      return interaction.editReply({ embeds: [embed] });
    }

    if (interaction.options.getString('confirm') !== 'KICK') {
      return interaction.editReply({ content: '⛔ Cleanup cancelled. The confirmation value must be exactly `KICK`.' });
    }

    let kicked = 0;
    const failed = [];
    for (const candidate of result.candidates) {
      try {
        console.log(`[RaidCleanup] Kicking ${candidate.member.user.tag} (${candidate.userId})${candidate.inviteCode ? ` invite=${candidate.inviteCode}` : ''}`);
        await candidate.member.kick(`Raid cleanup initiated by ${interaction.user.tag}`);
        kicked += 1;
        await sleep(750);
      } catch (error) {
        console.error(`[RaidCleanup] Failed to kick ${candidate.userId}:`, error?.message || error);
        failed.push(candidate.userId);
        await sleep(1000);
      }
    }

    console.log(`[RaidCleanup] Complete. Removed ${kicked}/${result.candidates.length} accounts.`);
    const embed = new EmbedBuilder()
      .setColor(failed.length ? 0xfee75c : 0x57f287)
      .setTitle('🧹 Raid Cleanup Complete')
      .addFields(
        { name: 'Mode', value: modeLabel },
        { name: 'Removed', value: String(kicked), inline: true },
        { name: 'Failed', value: String(failed.length), inline: true },
        { name: 'Matched', value: String(result.candidates.length), inline: true },
      )
      .setFooter({ text: 'KiwiVerse spaces kick requests to avoid hammering the Discord API.' })
      .setTimestamp();

    return interaction.editReply({ embeds: [embed] });
  },
};
