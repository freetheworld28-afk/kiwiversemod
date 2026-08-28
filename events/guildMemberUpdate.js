'use strict';

const { Events } = require('discord.js');
const { logEvent } = require('../services/loggingService');

module.exports = {
  name: Events.GuildMemberUpdate,
  async execute(oldMember, newMember, client, database) {
    try {
      if (newMember.user.bot) return;

      if (oldMember.nickname !== newMember.nickname) {
        await logEvent(newMember.guild, database, 'memberNicknameUpdate', {
          member: newMember,
          before: oldMember.nickname,
          after: newMember.nickname,
        });
      }

      const oldRoles = oldMember.roles.cache;
      const newRoles = newMember.roles.cache;
      const changed = oldRoles.size !== newRoles.size || !oldRoles.every((role) => newRoles.has(role.id));
      if (changed) {
        const added = Array.from(newRoles.filter((role) => !oldRoles.has(role.id)).values());
        const removed = Array.from(oldRoles.filter((role) => !newRoles.has(role.id)).values());
        if (added.length || removed.length) {
          await logEvent(newMember.guild, database, 'memberRolesUpdate', { member: newMember, added, removed });
        }
      }
    } catch (error) {
      console.error('[Logging] Error in guildMemberUpdate handler:', error);
    }
  },
};
