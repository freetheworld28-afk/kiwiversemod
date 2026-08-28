'use strict';

const { Events, AuditLogEvent } = require('discord.js');
const { logEvent, consumeSuppressed } = require('../services/loggingService');

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
  name: Events.GuildBanRemove,
  async execute(ban, client, database) {
    try {
      const guild = ban.guild;
      const user = ban.user;

      if (consumeSuppressed(`unban:${guild.id}:${user.id}`)) return;

      const auditInfo = await findAuditLogExecutor(guild, AuditLogEvent.MemberBanRemove, user.id);
      await logEvent(guild, database, 'memberUnban', {
        user,
        moderator: auditInfo?.executor || null,
        reason: auditInfo?.reason || null,
      });
    } catch (error) {
      console.error('[Logging] Error in guildBanRemove handler:', error);
    }
  },
};
