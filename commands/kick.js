const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { notifyUser } = require('../services/notificationService');
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
    .setName('kick')
    .setDescription('Kick a member from the server')
    .addUserOption((opt) => opt.setName('user').setDescription('Member to kick').setRequired(true))
    .addStringOption((opt) => opt.setName('reason').setDescription('Kick reason')),

  async execute(interaction, client, database) {
    const memberTier = getStaffTier(interaction.member);
    if (memberTier === null || memberTier < 1) {
      return interaction.reply({ content: '⛔ You need Moderator or higher to use this command.', flags: MessageFlags.Ephemeral });
    }

    const target = interaction.options.getUser('user');
    const reason = interaction.options.getString('reason') || 'No reason provided';
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      const member = await interaction.guild.members.fetch(target.id).catch(() => null);
      if (!member) return interaction.editReply({ content: '❌ Could not find that member in the server.' });

      const dm = await notifyUser(target, {
        title: '👢 You have been kicked',
        description: `You were kicked from **${interaction.guild.name}**.`,
        color: 0xe67e22,
        fields: [{ name: 'Reason', value: reason }],
        footer: 'You may rejoin unless server staff have restricted access.',
      });

      // Kicking fires GuildMemberRemove - suppress the generic "member left"
      // log for this departure so this richer kick-specific entry is the
      // only one posted.
      markSuppressed(`member-remove:${interaction.guild.id}:${target.id}`);

      await member.kick(`${interaction.user.tag} | ${reason}`);
      await logEvent(interaction.guild, database, 'memberKick', { target, moderator: interaction.user, reason, dmDelivered: dm.delivered });

      return interaction.editReply({
        content: `👢 **${target.tag}** has been kicked.\n${dm.delivered ? '📨 Member DM delivered.' : '⚠️ Discord would not deliver the member DM; this was logged for staff.'}`,
      });
    } catch (error) {
      console.error('Kick error:', error);
      return interaction.editReply({ content: `❌ Failed to kick user: ${error.message}` });
    }
  },
};
