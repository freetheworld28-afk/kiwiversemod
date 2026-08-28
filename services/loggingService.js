'use strict';

// Centralized logging service.
//
// Discord event -> logEvent(guild, database, type, data) -> guild settings
// check -> configured log channel lookup -> permission check -> embed build
// -> queued/rate-limited send -> result reported (never thrown).
//
// One function owns routing + embed construction for every logged event
// type, instead of each event handler duplicating its own EmbedBuilder code
// and channel-resolution logic. Sends are queued per-channel with a minimum
// spacing, and a channel with a large backlog (a raid, a mass mod action)
// automatically switches to compact batched summaries instead of firing one
// Discord API request per event.

const { EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const { getSetting } = require('./settingsService');

const WARN_COOLDOWN_MS = 10 * 60 * 1000; // don't repeat the same "not configured"/"missing permission" warning more than once per 10 min
const MIN_SEND_INTERVAL_MS = 350; // ~3 sends/sec per channel, safely under Discord's per-channel rate limit
const BATCH_WINDOW_MS = 600; // accumulate events for this long after the first one before sending, to catch a burst
const BATCH_CHUNK_SIZE = 10; // max event summaries per batched message
const SUPPRESS_TTL_MS = 5000; // dedupe window for a gateway event that mirrors a just-logged bot-initiated action

const metrics = {
  sent: 0,
  batched: 0,
  batchedEvents: 0,
  failed: 0,
  notConfigured: 0,
  missingPermission: 0,
};

function getMetrics() {
  return { ...metrics };
}

// ---- rate-limited diagnostics -------------------------------------------

const lastWarned = new Map();
function warnOnce(key, ...args) {
  const now = Date.now();
  const last = lastWarned.get(key) || 0;
  if (now - last < WARN_COOLDOWN_MS) return;
  lastWarned.set(key, now);
  console.warn(...args);
}

// ---- dedupe: suppress a gateway event that mirrors a bot-initiated log --

const suppressed = new Map(); // key -> expiresAt

function markSuppressed(key) {
  suppressed.set(key, Date.now() + SUPPRESS_TTL_MS);
}

// Returns true (and consumes the mark) if this key was recently suppressed.
function consumeSuppressed(key) {
  const expiresAt = suppressed.get(key);
  if (expiresAt === undefined) return false;
  suppressed.delete(key);
  return expiresAt > Date.now();
}

// Sweep expired suppression marks occasionally so the map can't grow
// unbounded if something marks a key and the matching event never fires.
let suppressedSweepCounter = 0;
function sweepSuppressed() {
  suppressedSweepCounter++;
  if (suppressedSweepCounter % 50 !== 0) return;
  const now = Date.now();
  for (const [key, expiresAt] of suppressed) {
    if (expiresAt <= now) suppressed.delete(key);
  }
}

// ---- channel resolution ---------------------------------------------------

// `category` picks a dedicated log channel (e.g. "message" -> a channel
// literally named "message-logs", matching Dyno-style setups that split
// logs by type) before falling back to the single generic logs channel.
async function getLogChannel(guild, database, category = null) {
  if (category) {
    const categoryChannelId = await getSetting(database, guild.id, `logging.${category}ChannelId`, null);
    if (categoryChannelId) {
      const channel = guild.channels.cache.get(categoryChannelId);
      if (channel && channel.isTextBased()) return channel;
    }

    const byName = guild.channels.cache.find(
      (ch) => ch.name === `${category}-logs` && ch.isTextBased(),
    );
    if (byName) return byName;
  }

  const channelId = await getSetting(database, guild.id, 'logging.channelId', null);
  if (channelId) {
    const channel = guild.channels.cache.get(channelId);
    if (channel && channel.isTextBased()) return channel;
  }

  return (
    guild.channels.cache.find((ch) => ch.name === process.env.LOGS_CHANNEL_NAME && ch.isTextBased())
    || guild.channels.cache.find((ch) => ch.name === 'default-logs' && ch.isTextBased())
    || null
  );
}

async function isEventLoggingEnabled(database, guildId, key) {
  const enabled = await getSetting(database, guildId, 'logging.enabled', true);
  if (!enabled) return false;
  return getSetting(database, guildId, key, true);
}

function checkChannelAccess(channel, guild) {
  const me = guild.members.me;
  if (!me) return { ok: false, missing: ['bot member not cached'] };
  const perms = channel.permissionsFor(me);
  if (!perms) return { ok: false, missing: ['unable to resolve permissions'] };

  const missing = [];
  if (!perms.has(PermissionFlagsBits.ViewChannel)) missing.push('View Channel');
  if (!perms.has(PermissionFlagsBits.SendMessages)) missing.push('Send Messages');
  if (!perms.has(PermissionFlagsBits.EmbedLinks)) missing.push('Embed Links');
  return { ok: missing.length === 0, missing };
}

function truncate(text, max = 1024) {
  if (!text) return text;
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

// ---- per-channel send queue -----------------------------------------------

const channelQueues = new Map(); // channelId -> { queue: [], processing: bool }

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describeDiscordError(error) {
  return {
    code: error?.code ?? 'UNKNOWN',
    status: error?.status ?? error?.httpStatus ?? null,
    message: error?.message || String(error),
  };
}

async function deliver(channel, payload, meta) {
  try {
    await channel.send(payload);
    metrics.sent++;
    return { delivered: true };
  } catch (error) {
    metrics.failed++;
    const info = describeDiscordError(error);
    warnOnce(
      `send-error:${meta.guildId}:${meta.type}`,
      `[Logging] Failed to deliver ${meta.type} log — guild=${meta.guildId} channel=${meta.channelId} code=${info.code} message=${info.message}`,
    );
    return { delivered: false, reason: 'discord_error', error: info };
  }
}

// Individual log events fire from independent, differently-latent async
// chains (a settings lookup, a permission check) - under a real burst
// (a raid, a mass mod action) they land in the queue a few hundred
// milliseconds apart, not atomically. Checking backlog depth only at
// send-time therefore rarely finds more than one item queued even during a
// genuine burst, since each item tends to get drained before the next one
// arrives. Accumulating for a short fixed window after the first item
// lands - then batching whatever arrived during that window - actually
// catches bursts regardless of arrival jitter, at the cost of a small,
// human-imperceptible delay on every log.
async function flushChannelQueue(channelId, channel, state) {
  const items = state.queue;
  channelQueues.delete(channelId);
  if (items.length === 0) return;

  if (items.length === 1) {
    await deliver(channel, { embeds: [items[0].embed] }, items[0].meta);
    return;
  }

  for (let i = 0; i < items.length; i += BATCH_CHUNK_SIZE) {
    const chunk = items.slice(i, i + BATCH_CHUNK_SIZE);
    const remaining = items.length - (i + chunk.length);
    const embed = new EmbedBuilder()
      .setColor(0x99aab5)
      .setTitle(`📋 ${items.length} events (batched — high volume)`)
      .setDescription(chunk.map((entry) => `• ${entry.summary}`).join('\n').slice(0, 4000))
      .setTimestamp();
    if (remaining > 0) embed.setFooter({ text: `${remaining} more in this batch` });
    await deliver(channel, { embeds: [embed] }, chunk[0].meta);
    metrics.batched++;
    metrics.batchedEvents += chunk.length;
    if (i + BATCH_CHUNK_SIZE < items.length) await sleep(MIN_SEND_INTERVAL_MS);
  }
}

function enqueue(channel, entry) {
  let state = channelQueues.get(channel.id);
  if (!state) {
    state = { queue: [], timer: null };
    channelQueues.set(channel.id, state);
  }
  state.queue.push(entry);
  if (!state.timer) {
    state.timer = setTimeout(() => {
      flushChannelQueue(channel.id, channel, state).catch((error) => {
        console.error('[Logging] queue flush crashed unexpectedly:', error);
        channelQueues.delete(channel.id);
      });
    }, BATCH_WINDOW_MS);
    state.timer.unref?.();
  }
}

// ---- embed builders per event type ----------------------------------------

function actorField(name, value) {
  return value ? [{ name, value, inline: true }] : [];
}

const EVENT_TYPES = {
  messageDelete: {
    category: 'message',
    settingKey: 'logging.messageDelete',
    build(data) {
      const { message, deletedBy } = data;
      const embed = new EmbedBuilder()
        .setColor(0xed4245)
        .setTitle('🗑️ Message Deleted')
        .addFields(
          { name: 'Channel', value: `${message.channel}`, inline: true },
          ...actorField('Deleted By', deletedBy),
        )
        .setFooter({ text: `Message ID: ${message.id}` })
        .setTimestamp();

      if (message.author) {
        embed.setAuthor({ name: `${message.author.tag} (${message.author.id})`, iconURL: message.author.displayAvatarURL() });
      }

      if (message.partial || message.content === null || message.content === undefined) {
        embed.addFields({ name: 'Content', value: '*Message was not cached — Discord does not retain deleted message content for uncached messages, so it cannot be recovered.*' });
      } else {
        embed.addFields({ name: 'Content', value: truncate(message.content) || '*empty*' });
      }

      if (message.attachments?.size > 0) {
        embed.addFields({
          name: `Attachments (${message.attachments.size})`,
          value: truncate(Array.from(message.attachments.values()).map((a) => a.url).join('\n'), 1024),
        });
      }

      return { embed, summary: `🗑️ Message from ${message.author?.tag || 'unknown user'} deleted in #${message.channel?.name || 'unknown'}${deletedBy ? ` (${deletedBy})` : ''}` };
    },
  },

  messageEdit: {
    category: 'message',
    settingKey: 'logging.messageEdit',
    build(data) {
      const { oldMessage, newMessage } = data;
      const embed = new EmbedBuilder()
        .setColor(0xfee75c)
        .setTitle('📝 Message Edited')
        .addFields(
          { name: 'Channel', value: `${newMessage.channel}`, inline: true },
          { name: 'Jump to Message', value: `[Click here](${newMessage.url})`, inline: true },
          {
            name: 'Before',
            value: oldMessage.partial
              ? '*Message was not cached — the original content cannot be recovered.*'
              : (truncate(oldMessage.content) || '*empty*'),
          },
          { name: 'After', value: truncate(newMessage.content) || '*empty*' },
        )
        .setFooter({ text: `Message ID: ${newMessage.id}` })
        .setTimestamp();

      if (newMessage.author) {
        embed.setAuthor({ name: `${newMessage.author.tag} (${newMessage.author.id})`, iconURL: newMessage.author.displayAvatarURL() });
      }

      return { embed, summary: `📝 Message from ${newMessage.author?.tag || 'unknown user'} edited in #${newMessage.channel?.name || 'unknown'}` };
    },
  },

  memberJoin: {
    category: 'member',
    settingKey: 'logging.memberJoin',
    build(data) {
      const { member } = data;
      const accountAgeDays = Math.floor((Date.now() - member.user.createdTimestamp) / 86400000);
      const embed = new EmbedBuilder()
        .setColor(0x57f287)
        .setTitle('📥 Member Joined')
        .setAuthor({ name: `${member.user.tag} (${member.user.id})`, iconURL: member.user.displayAvatarURL() })
        .addFields(
          { name: 'Account Created', value: `<t:${Math.floor(member.user.createdTimestamp / 1000)}:R> (${accountAgeDays}d ago)`, inline: true },
          { name: 'Member Count', value: `${member.guild.memberCount}`, inline: true },
        )
        .setTimestamp();
      return { embed, summary: `📥 ${member.user.tag} joined` };
    },
  },

  memberLeave: {
    category: 'member',
    settingKey: 'logging.memberLeave',
    build(data) {
      const { member } = data;
      const roles = member.roles?.cache
        ? Array.from(member.roles.cache.values()).filter((r) => r.id !== member.guild.id).map((r) => r.toString())
        : [];
      const embed = new EmbedBuilder()
        .setColor(0xed4245)
        .setTitle('📤 Member Left')
        .setAuthor({ name: `${member.user.tag} (${member.user.id})`, iconURL: member.user.displayAvatarURL() })
        .addFields(
          { name: 'Joined', value: member.joinedTimestamp ? `<t:${Math.floor(member.joinedTimestamp / 1000)}:R>` : 'Unknown', inline: true },
          { name: 'Member Count', value: `${member.guild.memberCount}`, inline: true },
        )
        .setTimestamp();
      if (roles.length) embed.addFields({ name: 'Roles', value: truncate(roles.join(' '), 1024) });
      return { embed, summary: `📤 ${member.user.tag} left` };
    },
  },

  memberBan: {
    category: 'member',
    settingKey: 'logging.moderation',
    build(data) {
      const { user, moderator, reason, native, extraFields } = data;
      const embed = new EmbedBuilder()
        .setColor(0xed4245)
        .setTitle('🔨 Member Banned')
        .addFields(
          { name: 'Target', value: `${user.tag} (${user.id})`, inline: true },
          ...actorField('Moderator', moderator ? `${moderator.tag}` : (native ? 'Unknown (not via bot)' : null)),
          ...(extraFields || []),
          { name: 'Reason', value: reason || 'No reason provided.' },
        )
        .setTimestamp();
      return { embed, summary: `🔨 ${user.tag} was banned${moderator ? ` by ${moderator.tag}` : ''}` };
    },
  },

  memberUnban: {
    category: 'member',
    settingKey: 'logging.moderation',
    build(data) {
      const { user, moderator, reason } = data;
      const embed = new EmbedBuilder()
        .setColor(0x57f287)
        .setTitle('🔓 Member Unbanned')
        .addFields(
          { name: 'Target', value: `${user.tag} (${user.id})`, inline: true },
          ...actorField('Moderator', moderator ? `${moderator.tag}` : 'Unknown (not via bot)'),
          { name: 'Reason', value: reason || 'No reason provided.' },
        )
        .setTimestamp();
      return { embed, summary: `🔓 ${user.tag} was unbanned` };
    },
  },

  memberKick: {
    category: 'member',
    settingKey: 'logging.moderation',
    build(data) {
      const { target, moderator, reason, dmDelivered } = data;
      const embed = new EmbedBuilder()
        .setColor(0xe67e22)
        .setTitle('👢 Member Kicked')
        .addFields(
          { name: 'Target', value: `${target.tag} (${target.id})`, inline: true },
          { name: 'Moderator', value: moderator.tag, inline: true },
          { name: 'Reason', value: reason || 'No reason provided.' },
          ...(dmDelivered === null || dmDelivered === undefined ? [] : [{ name: 'Member DM', value: dmDelivered ? '✅ Delivered' : '⚠️ Not delivered', inline: true }]),
        )
        .setTimestamp();
      return { embed, summary: `👢 ${target.tag} was kicked by ${moderator.tag}` };
    },
  },

  memberTimeout: {
    category: 'member',
    settingKey: 'logging.moderation',
    build(data) {
      const { target, moderator, reason, duration, dmDelivered } = data;
      const embed = new EmbedBuilder()
        .setColor(0xfee75c)
        .setTitle('⏳ Member Timed Out')
        .addFields(
          { name: 'Target', value: `${target.tag} (${target.id})`, inline: true },
          { name: 'Moderator', value: moderator.tag, inline: true },
          { name: 'Duration', value: duration, inline: true },
          { name: 'Reason', value: reason || 'No reason provided.' },
          ...(dmDelivered === null || dmDelivered === undefined ? [] : [{ name: 'Member DM', value: dmDelivered ? '✅ Delivered' : '⚠️ Not delivered', inline: true }]),
        )
        .setTimestamp();
      return { embed, summary: `⏳ ${target.tag} timed out for ${duration} by ${moderator.tag}` };
    },
  },

  memberWarn: {
    category: 'member',
    settingKey: 'logging.moderation',
    build(data) {
      const { target, moderator, reason, totalWarnings, dmDelivered } = data;
      const embed = new EmbedBuilder()
        .setColor(0xfee75c)
        .setTitle('⚠️ Warning Issued')
        .addFields(
          { name: 'Member', value: `${target.tag} (${target.id})`, inline: true },
          { name: 'Moderator', value: moderator.tag, inline: true },
          { name: 'Total Warnings', value: String(totalWarnings), inline: true },
          { name: 'Reason', value: reason || 'No reason provided.' },
          ...(dmDelivered === null || dmDelivered === undefined ? [] : [{ name: 'Member DM', value: dmDelivered ? '✅ Delivered' : '⚠️ Not delivered', inline: true }]),
        )
        .setTimestamp();
      return { embed, summary: `⚠️ ${target.tag} warned by ${moderator.tag} (${totalWarnings} total)` };
    },
  },

  memberRolesUpdate: {
    category: 'member',
    settingKey: 'logging.memberUpdate',
    build(data) {
      const { member, added, removed } = data;
      const embed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle('🎭 Member Roles Updated')
        .setAuthor({ name: `${member.user.tag} (${member.user.id})`, iconURL: member.user.displayAvatarURL() })
        .setTimestamp();
      if (added.length) embed.addFields({ name: 'Added', value: added.map((r) => r.toString()).join(' ') });
      if (removed.length) embed.addFields({ name: 'Removed', value: removed.map((r) => r.toString()).join(' ') });
      const parts = [];
      if (added.length) parts.push(`+${added.length}`);
      if (removed.length) parts.push(`-${removed.length}`);
      return { embed, summary: `🎭 ${member.user.tag} roles updated (${parts.join(' ') || 'no change'})` };
    },
  },

  memberNicknameUpdate: {
    category: 'member',
    settingKey: 'logging.memberUpdate',
    build(data) {
      const { member, before, after } = data;
      const embed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle('✏️ Nickname Changed')
        .setAuthor({ name: `${member.user.tag} (${member.user.id})`, iconURL: member.user.displayAvatarURL() })
        .addFields(
          { name: 'Before', value: before || '*none*', inline: true },
          { name: 'After', value: after || '*none*', inline: true },
        )
        .setTimestamp();
      return { embed, summary: `✏️ ${member.user.tag} nickname changed to "${after || member.user.username}"` };
    },
  },

  automodAction: {
    category: 'member',
    settingKey: 'logging.moderation',
    build(data) {
      const { message, violation } = data;
      const embed = new EmbedBuilder()
        .setColor(0xed4245)
        .setTitle('🛑 Content Filter Triggered')
        .setDescription(`Intercepted and deleted a message from ${message.channel}.`)
        .addFields(
          { name: 'Member', value: `${message.author.tag} (${message.author.id})`, inline: true },
          { name: 'Channel', value: `${message.channel}`, inline: true },
          { name: 'Violation Type', value: violation === 'slur' ? 'Prohibited language' : 'Invite link', inline: true },
          { name: 'Content', value: truncate(message.content, 500) || '*empty*' },
        )
        .setFooter({ text: 'Deleted automatically' })
        .setTimestamp();
      return { embed, summary: `🛑 Content filter deleted a message from ${message.author.tag} (${violation})` };
    },
  },

  antiRaid: {
    category: 'member',
    settingKey: 'logging.moderation',
    build(data) {
      const { joinCount, lockedChannel } = data;
      const embed = new EmbedBuilder()
        .setColor(0xed4245)
        .setTitle('🚨 Anti-Raid Lockdown Engaged')
        .setDescription(`Detected **${joinCount} joins** in a 5-second window.`)
        .addFields({ name: 'Channel Locked', value: `${lockedChannel}` })
        .setTimestamp();
      return { embed, summary: `🚨 Anti-raid lockdown engaged (${joinCount} joins)` };
    },
  },

  raidCleanup: {
    category: 'member',
    settingKey: 'logging.moderation',
    build(data) {
      const { moderator, mode, kicked, failed, matched } = data;
      const embed = new EmbedBuilder()
        .setColor(failed > 0 ? 0xfee75c : 0x57f287)
        .setTitle('🧹 Raid Cleanup Executed')
        .addFields(
          { name: 'Moderator', value: moderator.tag, inline: true },
          { name: 'Mode', value: mode, inline: true },
          { name: 'Removed', value: String(kicked), inline: true },
          { name: 'Failed', value: String(failed), inline: true },
          { name: 'Matched', value: String(matched), inline: true },
        )
        .setTimestamp();
      return { embed, summary: `🧹 Raid cleanup by ${moderator.tag}: removed ${kicked}/${matched}` };
    },
  },

  ticketEvent: {
    category: 'server',
    settingKey: 'logging.tickets',
    build(data) {
      const { action, ticketId, user, moderator, extra } = data;
      const colors = { opened: 0x5865f2, closed: 0xed4245, reopened: 0x57f287, deleted: 0x99aab5 };
      const titles = { opened: '🎫 Ticket Opened', closed: '🔒 Ticket Closed', reopened: '🔓 Ticket Reopened', deleted: '🗑️ Ticket Deleted' };
      const embed = new EmbedBuilder()
        .setColor(colors[action] || 0x5865f2)
        .setTitle(titles[action] || `Ticket ${action}`)
        .addFields(
          { name: 'Ticket', value: `#${ticketId}`, inline: true },
          ...actorField('Member', user ? `${user.tag} (${user.id})` : null),
          ...actorField('Staff', moderator ? `${moderator.tag}` : null),
        )
        .setTimestamp();
      if (extra) embed.addFields({ name: 'Details', value: truncate(extra, 1024) });
      return { embed, summary: `${titles[action] || action} — #${ticketId}` };
    },
  },

  applicationDecision: {
    category: 'server',
    settingKey: 'logging.tickets',
    build(data) {
      const { applicationId, applicationType, applicant, moderator, status } = data;
      const colors = { accepted: 0x57f287, rejected: 0xed4245, interview: 0x5865f2 };
      const embed = new EmbedBuilder()
        .setColor(colors[status] || 0x5865f2)
        .setTitle(`📝 Application ${status}`)
        .addFields(
          { name: 'Application', value: `${applicationType} #${applicationId}`, inline: true },
          { name: 'Applicant', value: `${applicant.tag} (${applicant.id})`, inline: true },
          { name: 'Reviewer', value: moderator.tag, inline: true },
        )
        .setTimestamp();
      return { embed, summary: `📝 Application #${applicationId} (${applicationType}) ${status} for ${applicant.tag}` };
    },
  },

  giveawayEvent: {
    category: 'server',
    settingKey: 'logging.giveaways',
    build(data) {
      const { action, giveawayId, prize, host, winners } = data;
      const titles = { started: '🎉 Giveaway Started', ended: '🏁 Giveaway Ended', rerolled: '🔁 Giveaway Rerolled' };
      const embed = new EmbedBuilder()
        .setColor(0x8b5cf6)
        .setTitle(titles[action] || `Giveaway ${action}`)
        .addFields(
          { name: 'Giveaway', value: `#${giveawayId} — ${prize}`, inline: true },
          ...actorField('Hosted By', host ? `${host.tag}` : null),
        )
        .setTimestamp();
      if (winners?.length) embed.addFields({ name: 'Winners', value: winners.map((w) => `<@${w}>`).join(', ') });
      return { embed, summary: `${titles[action] || action} — #${giveawayId} (${prize})` };
    },
  },

  configChange: {
    category: 'server',
    settingKey: 'logging.configChanges',
    build(data) {
      const { keys, source } = data;
      const embed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle('🔧 Server Configuration Changed')
        .addFields(
          { name: 'Changed Keys', value: truncate(keys.join(', '), 1024) || '*none*' },
          ...actorField('Source', source),
        )
        .setTimestamp();
      return { embed, summary: `🔧 Config changed: ${keys.slice(0, 5).join(', ')}${keys.length > 5 ? ` +${keys.length - 5} more` : ''}` };
    },
  },
};

// ---- the central entry point -----------------------------------------------

// Never throws. Always resolves to a result object describing what happened,
// so a broken logging channel can never take down whatever feature called it.
async function logEvent(guild, database, type, data = {}) {
  try {
    const def = EVENT_TYPES[type];
    if (!def) {
      console.error(`[Logging] Unknown event type "${type}" — call site bug, not a config problem.`);
      return { delivered: false, reason: 'unknown_type' };
    }

    sweepSuppressed();

    if (!(await isEventLoggingEnabled(database, guild.id, def.settingKey))) {
      return { delivered: false, reason: 'disabled' };
    }

    const channel = await getLogChannel(guild, database, def.category);
    if (!channel) {
      metrics.notConfigured++;
      warnOnce(
        `not-configured:${guild.id}:${def.category}`,
        `[Logging] No log channel configured for category "${def.category}" in guild ${guild.id} — set logging.${def.category}ChannelId, logging.channelId, or create a "${def.category}-logs"/"default-logs" channel.`,
      );
      return { delivered: false, reason: 'not_configured' };
    }

    const access = checkChannelAccess(channel, guild);
    if (!access.ok) {
      metrics.missingPermission++;
      warnOnce(
        `missing-permission:${guild.id}:${channel.id}`,
        `[Logging] Missing permission(s) in #${channel.name} (${channel.id}) for guild ${guild.id}: ${access.missing.join(', ')}`,
      );
      return { delivered: false, reason: 'missing_permission', missing: access.missing };
    }

    let built;
    try {
      built = def.build(data);
    } catch (buildError) {
      console.error(`[Logging] Failed to build embed for event type "${type}":`, buildError);
      return { delivered: false, reason: 'build_error', error: buildError.message };
    }

    enqueue(channel, { embed: built.embed, summary: built.summary, meta: { guildId: guild.id, channelId: channel.id, type } });
    return { delivered: true, reason: 'queued' };
  } catch (error) {
    console.error(`[Logging] Unexpected failure logging event "${type}" for guild ${guild?.id}:`, error);
    return { delivered: false, reason: 'internal_error', error: error.message };
  }
}

module.exports = {
  logEvent,
  getLogChannel,
  isEventLoggingEnabled,
  truncate,
  markSuppressed,
  consumeSuppressed,
  getMetrics,
};
