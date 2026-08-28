'use strict';

const { Events } = require('discord.js');
const inviteTracker = require('../services/inviteTrackerService');
const { logEvent, consumeSuppressed } = require('../services/loggingService');

module.exports = {
  name: Events.GuildMemberRemove,
  async execute(member, client, database) {
    try {
      await inviteTracker.handleMemberRemove(member, database);
    } catch (error) {
      console.error('Invite tracker member-remove error:', error);
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
