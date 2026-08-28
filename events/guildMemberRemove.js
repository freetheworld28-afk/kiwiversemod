'use strict';

const { Events } = require('discord.js');
const inviteTracker = require('../services/inviteTrackerService');
const { logEvent, consumeSuppressed } = require('../services/loggingService');
const { getCachedSettingsByPrefix } = require('../services/settingsService');

function applyTemplate(template, member) {
  return template
    .replaceAll('{user}', member.user.tag)
    .replaceAll('{server}', member.guild.name);
}

module.exports = {
  name: Events.GuildMemberRemove,
  async execute(member, client, database) {
    try {
      await inviteTracker.handleMemberRemove(member, database);
    } catch (error) {
      console.error('Invite tracker member-remove error:', error);
    }

    // Public "member left" announcement - independent of the mod-log entry
    // below (a kicked member's departure is still worth announcing publicly
    // even though its mod-log entry is suppressed in favor of /kick's own).
    try {
      const welcomeSettings = await getCachedSettingsByPrefix(database, member.guild.id, 'welcome');
      const leaveChannel = welcomeSettings.leaveChannelId && member.guild.channels.cache.get(welcomeSettings.leaveChannelId);
      if (leaveChannel?.isTextBased()) {
        const message = applyTemplate(welcomeSettings.leaveMessage || '{user} has left {server}.', member);
        await leaveChannel.send(message).catch((error) => console.error('[Welcome] Failed to send leave message:', error));
      }
    } catch (error) {
      console.error('[Welcome] Error sending leave message:', error);
    }

    try {
      // A kick fires GuildMemberRemove too - if /kick just logged this exact
      // departure, don't also post a generic "member left" entry for it.
      if (consumeSuppressed(`member-remove:${member.guild.id}:${member.id}`)) return;
      await logEvent(member.guild, database, 'memberLeave', { member });
    } catch (error) {
      console.error('[Logging] Error logging member leave:', error);
    }
  },
};
