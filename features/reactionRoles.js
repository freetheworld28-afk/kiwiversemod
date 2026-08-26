'use strict';

const reactionRoleService = require('../services/reactionRoleService');

function emojiKey(emoji) {
  return emoji.id || emoji.name;
}

module.exports = {
  name: 'reactionRoles',

  async onReactionAdd(reaction, user, client, database) {
    const guild = reaction.message.guild;
    if (!guild) return;

    const binding = await reactionRoleService.getBinding(database, guild.id, reaction.message.id, emojiKey(reaction.emoji));
    if (!binding) return;

    const member = await guild.members.fetch(user.id).catch(() => null);
    if (!member || member.roles.cache.has(binding.role_id)) return;

    await member.roles.add(binding.role_id, 'Reaction role').catch((error) => {
      console.error(`Failed to add reaction role ${binding.role_id} to ${user.id}:`, error);
    });
  },

  async onReactionRemove(reaction, user, client, database) {
    const guild = reaction.message.guild;
    if (!guild) return;

    const binding = await reactionRoleService.getBinding(database, guild.id, reaction.message.id, emojiKey(reaction.emoji));
    if (!binding) return;

    const member = await guild.members.fetch(user.id).catch(() => null);
    if (!member || !member.roles.cache.has(binding.role_id)) return;

    await member.roles.remove(binding.role_id, 'Reaction role removed').catch((error) => {
      console.error(`Failed to remove reaction role ${binding.role_id} from ${user.id}:`, error);
    });
  },
};
