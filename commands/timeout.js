const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder, MessageFlags } = require('discord.js');
const { notifyUser } = require('../services/notificationService');

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

function formatDuration(ms) {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days} day${days > 1 ? 's' : ''}`;
  if (hours > 0) return `${hours} hour${hours > 1 ? 's' : ''}`;
  if (minutes > 0) return `${minutes} minute${minutes > 1 ? 's' : ''}`;
  return `${seconds} second${seconds > 1 ? 's' : ''}`;
}

async function logModAction(interaction, target, reason, duration, dmDelivered) {
  const logsChannel = interaction.guild.channels.cache.find(
    (ch) => ch.name === process.env.LOGS_CHANNEL_NAME && ch.isTextBased(),
  );
  if (!logsChannel) return;

  const embed = new EmbedBuilder()
    .setColor(0xfee75c)
    .setTitle('📋 Timeout Issued')
    .addFields(
      { name: 'Target', value: `${target.tag} (${target.id})`, inline: true },
      { name: 'Moderator', value: interaction.user.tag, inline: true },
      { name: 'Duration', value: duration, inline: true },
      { name: 'Reason', value: reason },
      { name: 'Member DM', value: dmDelivered ? '✅ Delivered' : '⚠️ Not delivered', inline: true },
    )
    .setTimestamp();
  await logsChannel.send({ embeds: [embed] }).catch(() => null);
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('timeout')
    .setDescription('Timeout (mute) a member temporarily')
    .addUserOption((opt) => opt.setName('user').setDescription('Member to timeout').setRequired(true))
    .addStringOption((opt) =>
      opt
        .setName('duration')
        .setDescription('How long should the timeout last?')
        .setRequired(true)
        .addChoices(
          { name: '60 seconds', value: '60000' },
          { name: '5 minutes', value: '300000' },
          { name: '10 minutes', value: '600000' },
          { name: '30 minutes', value: '1800000' },
          { name: '1 hour', value: '3600000' },
          { name: '6 hours', value: '21600000' },
          { name: '12 hours', value: '43200000' },
          { name: '1 day', value: '86400000' },
          { name: '1 week', value: '604800000' },
        ),
    )
    .addStringOption((opt) => opt.setName('reason').setDescription('Timeout reason')),

  async execute(interaction) {
    const memberTier = getStaffTier(interaction.member);
    if (memberTier === null || memberTier < 0) {
      return interaction.reply({ content: '⛔ You need Trial Mod or higher to use this command.', flags: MessageFlags.Ephemeral });
    }

    const target = interaction.options.getUser('user');
    const durationMs = Number.parseInt(interaction.options.getString('duration'), 10);
    const reason = interaction.options.getString('reason') || 'No reason provided';
    const durationStr = formatDuration(durationMs);
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      const member = await interaction.guild.members.fetch(target.id).catch(() => null);
      if (!member) return interaction.editReply({ content: '❌ Could not find that member in the server.' });

      const dm = await notifyUser(target, {
        title: '⏳ You have been timed out',
        description: `You were timed out in **${interaction.guild.name}**.`,
        color: 0xfee75c,
        fields: [
          { name: 'Duration', value: durationStr, inline: true },
          { name: 'Reason', value: reason },
        ],
        footer: 'Your ability to interact will return automatically when the timeout expires.',
      });

      await member.timeout(durationMs, `${interaction.user.tag} | ${reason}`);
      await logModAction(interaction, target, reason, durationStr, dm.delivered);

      return interaction.editReply({
        content: `⏳ **${target.tag}** has been timed out for ${durationStr}.\n${dm.delivered ? '📨 Member DM delivered.' : '⚠️ Discord would not deliver the member DM; this was logged for staff.'}`,
      });
    } catch (error) {
      console.error('Timeout error:', error);
      return interaction.editReply({ content: `❌ Failed to timeout user: ${error.message}` });
    }
  },
};
