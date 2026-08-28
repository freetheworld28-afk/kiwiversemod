'use strict';

const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { logEvent, markSuppressed } = require('../services/loggingService');

const STAFF_TIERS = [
  { label: 'Trial Mod', id: process.env.TRIAL_MOD_ROLE_ID },
  { label: 'Moderator', id: process.env.MOD_ROLE_ID },
  { label: 'Senior Moderator', id: process.env.SR_MOD_ROLE_ID },
  { label: 'Admin', id: process.env.ADMIN_ROLE_ID },
];

function getStaffTier(member) {
  if (!member || !member.permissions || !member.roles?.cache) return null;
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return STAFF_TIERS.length - 1;
  let highestTier = null;
  STAFF_TIERS.forEach((tier, index) => {
    if (tier.id && member.roles.cache.has(tier.id)) highestTier = index;
  });
  return highestTier;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('unban')
    .setDescription('Remove a ban from a user')
    .addStringOption((opt) => opt.setName('user_id').setDescription('Discord user ID to unban').setRequired(true))
    .addStringOption((opt) => opt.setName('reason').setDescription('Unban reason')),

  async execute(interaction, client, database) {
    const memberTier = getStaffTier(interaction.member);
    if (memberTier === null || memberTier < 2) {
      return interaction.reply({ content: '⛔ You need Senior Moderator or higher to use this command.', flags: MessageFlags.Ephemeral });
    }

    const userId = interaction.options.getString('user_id').trim();
    const reason = interaction.options.getString('reason') || 'No reason provided';

    if (!/^\d{17,20}$/.test(userId)) {
      return interaction.reply({ content: '❌ That doesn\'t look like a valid Discord user ID.', flags: MessageFlags.Ephemeral });
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      const existingBan = await interaction.guild.bans.fetch(userId).catch(() => null);
      if (!existingBan) {
        return interaction.editReply({ content: '❌ That user is not currently banned.' });
      }

      // Discord fires GuildBanRemove for this too - suppress it so this
      // command-level log (with the moderator and reason) is the single
      // entry, not a duplicate.
      markSuppressed(`unban:${interaction.guild.id}:${userId}`);

      await interaction.guild.members.unban(userId, `${interaction.user.tag} | ${reason}`);

      await logEvent(interaction.guild, database, 'memberUnban', {
        user: existingBan.user,
        moderator: interaction.user,
        reason,
      });

      return interaction.editReply({ content: `🔓 **${existingBan.user.tag}** has been unbanned.` });
    } catch (error) {
      console.error('Unban error:', error);
      return interaction.editReply({ content: `❌ Failed to unban user: ${error.message}` });
    }
  },
};
