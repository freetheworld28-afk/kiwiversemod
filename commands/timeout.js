const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder, MessageFlags } = require('discord.js');

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

async function sendDMToUser(user, action, reason, duration = null, guildName = null) {
  try {
    const embed = new EmbedBuilder()
      .setColor(action === 'Ban' ? 0xed4245 : action === 'Kick' ? 0xe67e22 : 0xfee75c)
      .setTitle(`⚠️ You have been ${action.toLowerCase()}ed`)
      .setDescription(`You were ${action.toLowerCase()}ed from **${guildName}**`)
      .addFields(
        { name: 'Reason', value: reason || 'No reason provided' },
        ...(duration ? [{ name: 'Duration', value: duration, inline: true }] : []),
      )
      .setFooter({ text: 'If you believe this was a mistake, contact server staff.' })
      .setTimestamp();

    await user.send({ embeds: [embed] });
    return true;
  } catch (error) {
    console.error(`Failed to DM user ${user.tag}:`, error.message);
    return false;
  }
}

async function logModAction(interaction, action, target, reason, extraFields = []) {
  const logsChannel = interaction.guild.channels.cache.find(
    (ch) => ch.name === process.env.LOGS_CHANNEL_NAME && ch.isTextBased(),
  );

  if (logsChannel) {
    const embed = new EmbedBuilder()
      .setColor(action === 'Ban' ? 0xed4245 : action === 'Kick' ? 0xe67e22 : 0xfee75c)
      .setTitle(`📋 ${action} Issued`)
      .addFields(
        { name: 'Target', value: `${target.tag} (${target.id})`, inline: true },
        { name: 'Moderator', value: `${interaction.user.tag}`, inline: true },
        ...extraFields,
        { name: 'Reason', value: reason || 'No reason provided.' },
      )
      .setFooter({ text: `Actioned by ${interaction.user.tag}` })
      .setTimestamp();

    await logsChannel.send({ embeds: [embed] }).catch(() => null);
  }
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

  async execute(interaction, client, database, cache) {
    const memberTier = getStaffTier(interaction.member);
    if (memberTier === null || memberTier < 0) {
      return interaction.reply({
        content: '⛔ You need Trial Mod or higher to use this command.',
        flags: MessageFlags.Ephemeral,
      });
    }

    const target = interaction.options.getUser('user');
    const durationMs = Number.parseInt(interaction.options.getString('duration'), 10);
    const reason = interaction.options.getString('reason') || 'No reason provided';
    const durationStr = formatDuration(durationMs);

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      // Send DM to user first
      await sendDMToUser(target, 'Timeout', reason, durationStr, interaction.guild.name);

      // Get the member and timeout them
      const member = await interaction.guild.members.fetch(target.id).catch(() => null);
      if (!member) {
        return interaction.editReply({
          content: '❌ Could not find that member in the server.',
        });
      }

      await member.timeout(durationMs, `${interaction.user.tag} | ${reason}`);

      // Log the action
      await logModAction(interaction, 'Timeout', target, reason, [
        { name: 'Duration', value: durationStr, inline: true },
      ]);

      return interaction.editReply({
        content: `⏳ **${target.tag}** has been timed out for ${durationStr}.\n📨 DM sent to user.`,
      });
    } catch (error) {
      console.error('Timeout error:', error);
      return interaction.editReply({
        content: `❌ Failed to timeout user: ${error.message}`,
      });
    }
  },
};

