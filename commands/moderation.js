const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder, MessageFlags } = require('discord.js');
const { notifyUser } = require('../services/notificationService');
const { getLogChannel } = require('../services/loggingService');

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

async function logModAction(interaction, database, action, target, reason, extraFields = [], dmDelivered = null) {
  const logsChannel = await getLogChannel(interaction.guild, database, 'member');

  if (logsChannel) {
    const embed = new EmbedBuilder()
      .setColor(action === 'Ban' ? 0xed4245 : action === 'Kick' ? 0xe67e22 : 0xfee75c)
      .setTitle(`📋 ${action} Issued`)
      .addFields(
        { name: 'Target', value: `${target.tag} (${target.id})`, inline: true },
        { name: 'Moderator', value: `${interaction.user.tag}`, inline: true },
        ...extraFields,
        { name: 'Reason', value: reason || 'No reason provided.' },
        ...(dmDelivered === null ? [] : [{ name: 'Member DM', value: dmDelivered ? '✅ Delivered' : '⚠️ Not delivered', inline: true }]),
      )
      .setFooter({ text: `Actioned by ${interaction.user.tag}` })
      .setTimestamp();

    await logsChannel.send({ embeds: [embed] }).catch(() => null);
  }
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('ban')
    .setDescription('Permanently ban a member from the server')
    .addUserOption((opt) => opt.setName('user').setDescription('Member to ban').setRequired(true))
    .addStringOption((opt) => opt.setName('reason').setDescription('Ban reason'))
    .addIntegerOption((opt) =>
      opt.setName('days').setDescription('Delete messages from this many days back').setMinValue(0).setMaxValue(7),
    ),

  async execute(interaction, client, database) {
    const memberTier = getStaffTier(interaction.member);
    if (memberTier === null || memberTier < 2) {
      return interaction.reply({
        content: '⛔ You need Senior Moderator or higher to use this command.',
        flags: MessageFlags.Ephemeral,
      });
    }

    const target = interaction.options.getUser('user');
    const reason = interaction.options.getString('reason') || 'No reason provided';
    const purgeDays = interaction.options.getInteger('days') || 0;

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      const dm = await notifyUser(target, {
        title: '🔨 You have been banned',
        description: `You were banned from **${interaction.guild.name}**.`,
        color: 0xed4245,
        fields: [{ name: 'Reason', value: reason }],
        footer: 'If you believe this was a mistake, use the server appeal process if available.',
      });

      await interaction.guild.members.ban(target.id, {
        deleteMessageSeconds: purgeDays * 86400,
        reason: `${interaction.user.tag} | ${reason}`,
      });

      await logModAction(interaction, database, 'Ban', target, reason, [
        { name: 'Message Purge', value: `${purgeDays} day(s)`, inline: true },
      ], dm.delivered);

      return interaction.editReply({
        content: `🔨 **${target.tag}** has been banned.\n${dm.delivered ? '📨 Member DM delivered.' : '⚠️ Discord would not deliver the member DM; this was logged for staff.'}`,
      });
    } catch (error) {
      console.error('Ban error:', error);
      return interaction.editReply({
        content: `❌ Failed to ban user: ${error.message}`,
      });
    }
  },
};
