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
    .setName('kick')
    .setDescription('Kick a member from the server')
    .addUserOption((opt) => opt.setName('user').setDescription('Member to kick').setRequired(true))
    .addStringOption((opt) => opt.setName('reason').setDescription('Kick reason')),

  async execute(interaction, client, database, cache) {
    const memberTier = getStaffTier(interaction.member);
    if (memberTier === null || memberTier < 1) {
      return interaction.reply({
        content: '⛔ You need Moderator or higher to use this command.',
        flags: MessageFlags.Ephemeral,
      });
    }

    const target = interaction.options.getUser('user');
    const reason = interaction.options.getString('reason') || 'No reason provided';

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      // Send DM to user first
      await sendDMToUser(target, 'Kick', reason, null, interaction.guild.name);

      // Get the member and kick them
      const member = await interaction.guild.members.fetch(target.id).catch(() => null);
      if (!member) {
        return interaction.editReply({
          content: '❌ Could not find that member in the server.',
        });
      }

      await member.kick(`${interaction.user.tag} | ${reason}`);

      // Log the action
      await logModAction(interaction, 'Kick', target, reason);

      return interaction.editReply({
        content: `👢 **${target.tag}** has been kicked.\n📨 DM sent to user.`,
      });
    } catch (error) {
      console.error('Kick error:', error);
      return interaction.editReply({
        content: `❌ Failed to kick user: ${error.message}`,
      });
    }
  },
};

