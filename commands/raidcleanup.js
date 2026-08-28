'use strict';

const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  EmbedBuilder,
  AuditLogEvent,
  MessageFlags,
} = require('discord.js');
const { logEvent } = require('../services/loggingService');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A mistaken wide time window/filter could otherwise match hundreds of
// legitimate members and mass-kick them in one command. Above this count,
// execute refuses and asks the operator to narrow the filters instead of
// silently actioning everything that matched.
const MAX_CANDIDATES_PER_RUN = 50;

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

async function fetchAllMembers(guild) {
  try {
    // With the Server Members Intent enabled, this requests the complete guild
    // member list instead of relying on the partial cache from startup.
    await guild.members.fetch();
    return { ok: true };
  } catch (error) {
    console.error('[RaidCleanup] Failed to fetch guild members:', error);
    return { ok: false, error };
  }
}

function candidatesFromWindow(guild, startMs, endMs, onlyEveryone) {
  const rows = [];
  const stats = {
    fetched: guild.members.cache.size,
    inWindow: 0,
    botsInWindow: 0,
    excludedByRole: 0,
    excludedNotKickable: 0,
    protected: 0,
    final: 0,
  };

  for (const member of guild.members.cache.values()) {
    if (!member.joinedTimestamp) continue;
    if (member.joinedTimestamp < startMs || member.joinedTimestamp > endMs) continue;

    stats.inWindow += 1;

    if (member.user.bot) {
      stats.botsInWindow += 1;
      continue;
    }

    // Never allow the bot to remove the server owner or the administrator
    // who started this operation; those are handled by buildCandidateSet.
    if (onlyEveryone && member.roles.cache.size !== 1) {
      stats.excludedByRole += 1;
      continue;
    }

    if (!member.kickable) {
      stats.excludedNotKickable += 1;
      continue;
    }

    rows.push({
      userId: member.id,
      joinedAt: new Date(member.joinedTimestamp).toISOString(),
      inviteCode: null,
      roleCount: member.roles.cache.size,
    });
  }

  stats.final = rows.length;
  return { rows, stats };
}

async function buildCandidateSet(interaction, database) {
  const maliciousBotId = interaction.options.getString('bot_id');
  const anyBot = interaction.options.getBoolean('any_bot') ?? false;
  // IMPORTANT: role filtering is now opt-in. Raid cleanup should not silently
  // discard legitimate raid accounts merely because an auto-role was assigned.
  const onlyEveryone = interaction.options.getBoolean('only_everyone') ?? false;
  const start = interaction.options.getString('start');
  const end = interaction.options.getString('end');

  const codes = (anyBot || maliciousBotId)
    ? await getBotCreatedInviteCodes(interaction.guild, anyBot ? null : maliciousBotId)
    : new Set();

  let candidates = await candidatesFromTrackedInvites(database, interaction.guild.id, codes);
  let mode = codes.size && candidates.length ? (anyBot ? 'all_bot_invites' : 'tracked_invites') : 'time_window';
  let stats = {
    fetched: interaction.guild.members.cache.size,
    inWindow: 0,
    botsInWindow: 0,
    excludedByRole: 0,
    excludedNotKickable: 0,
    protected: 0,
    final: candidates.length,
  };

  // Fetch the complete member list ONCE. Historical cleanup can involve hundreds
  // of accounts; fetching each member individually is slow and can fail/rate-limit.
  const fetched = await fetchAllMembers(interaction.guild);
  if (!fetched.ok) {
    return {
      error: 'KiwiVerse could not fetch the server member list. Make sure the Server Members Intent is enabled for the bot and that it has permission to view/kick members.',
      codes: Array.from(codes),
    };
  }
  stats.fetched = interaction.guild.members.cache.size;

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

    const windowResult = candidatesFromWindow(interaction.guild, startMs, endMs, onlyEveryone);
    candidates = windowResult.rows;
    stats = windowResult.stats;
  }

  const unique = new Map();
  for (const row of candidates) {
    if (row.userId === interaction.guild.ownerId || row.userId === interaction.user.id) {
      stats.protected += 1;
      continue;
    }
    const member = interaction.guild.members.cache.get(row.userId);
    if (!member || !member.kickable) {
      stats.excludedNotKickable += 1;
      continue;
    }
    unique.set(row.userId, { ...row, member });
  }

  stats.final = unique.size;
  return {
    mode,
    codes: Array.from(codes),
    candidates: Array.from(unique.values()),
    onlyEveryone,
    stats,
    start,
    end,
  };
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
      .setDescription('Fallback: ONLY match members with exactly @everyone (default false)'));
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

    let result;
    try {
      result = await buildCandidateSet(interaction, database);
    } catch (error) {
      console.error('[RaidCleanup] Preview/build failed:', error);
      return interaction.editReply({
        content: `⚠️ Raid scan failed: \`${String(error?.message || error).slice(0, 500)}\`\nCheck Railway logs for the full error.`,
      });
    }

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
        : `Join-time fallback (${result.onlyEveryone ? '@everyone-only accounts' : 'ALL kickable human accounts in window'})`;

    if (interaction.options.getSubcommand() === 'preview') {
      const s = result.stats || {};
      const embed = new EmbedBuilder()
        .setColor(0xfee75c)
        .setTitle('🧹 Raid Cleanup Preview')
        .setDescription(`**Mode:** ${modeLabel}\n**Candidates:** ${result.candidates.length}\n**Bot-created invite codes found:** ${result.codes.length}`)
        .addFields(
          {
            name: '🔎 Scan breakdown',
            value: [
              `Members fetched: **${s.fetched ?? 0}**`,
              `Joined in window: **${s.inWindow ?? 0}**`,
              `Bots in window: **${s.botsInWindow ?? 0}**`,
              `Excluded by role: **${s.excludedByRole ?? 0}**`,
              `Not kickable: **${s.excludedNotKickable ?? 0}**`,
              `Protected: **${s.protected ?? 0}**`,
              `Final candidates: **${s.final ?? result.candidates.length}**`,
            ].join('\n'),
          },
          { name: 'First candidates', value: sample.slice(0, 1024) },
        )
        .setFooter({ text: 'Nothing has been kicked. Review the count and sample before running execute.' })
        .setTimestamp();
      return interaction.editReply({ embeds: [embed] });
    }

    if (interaction.options.getString('confirm') !== 'KICK') {
      return interaction.editReply({ content: '⛔ Cleanup cancelled. The confirmation value must be exactly `KICK`.' });
    }

    if (result.candidates.length > MAX_CANDIDATES_PER_RUN) {
      return interaction.editReply({
        content: `⛔ Cleanup cancelled - ${result.candidates.length} candidates matched, above the safety cap of ${MAX_CANDIDATES_PER_RUN}. Narrow the time window or role filter and preview again before running execute on a batch this large.`,
      });
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

    await logEvent(interaction.guild, database, 'raidCleanup', {
      moderator: interaction.user,
      mode: modeLabel,
      kicked,
      failed: failed.length,
      matched: result.candidates.length,
    });

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
