'use strict';

const { Events, AuditLogEvent } = require('discord.js');
const { logEvent, consumeSuppressed } = require('../services/loggingService');

// Best-effort attribution for a ban not issued through this bot (done
// natively in Discord's UI, or by another bot/tool) - requires View Audit
// Log; if that fails or nothing matches, we still log the ban itself, just
// without a moderator/reason.
async function findAuditLogExecutor(guild, type, targetId) {
  try {
    const audit = await guild.fetchAuditLogs({ type, limit: 5 });
    const entry = audit.entries.find((e) => e.target?.id === targetId && Date.now() - e.createdTimestamp < 10000);
    return entry ? { executor: entry.executor, reason: entry.reason } : null;
  } catch {
    return null;
  }
}

module.exports = {
  name: Events.GuildBanAdd,
  async execute(ban, client, database) {
    try {
      const guild = ban.guild;
      const user = ban.user;

      // If this ban was just issued through the bot's own /ban command, that
      // handler already posted a richer log entry with full command context
      // - skip the duplicate Discord fires via this gateway event.
      if (consumeSuppressed(`ban:${guild.id}:${user.id}`)) return;

      const auditInfo = await findAuditLogExecutor(guild, AuditLogEvent.MemberBanAdd, user.id);
      await logEvent(guild, database, 'memberBan', {
        user,
        moderator: auditInfo?.executor || null,
        reason: ban.reason || auditInfo?.reason || null,
        native: true,
      });
    } catch (error) {
      console.error('[Logging] Error in guildBanAdd handler:', error);
    }
  },
};
