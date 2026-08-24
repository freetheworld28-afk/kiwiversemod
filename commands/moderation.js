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

async function logModAction(interaction, action, target, reason, extraFields = []) {
  const logsChannel = interaction.guild.channels.cache.find(
    (ch) => ch.name === process.env.LOGS_CHANNEL_NAME && ch.isTextBased(),
  );

  if (logsChannel) {
    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle(`📋 ${action}`)
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

  const db = await (await import('../index.js')).database;
  await db.run(
    `INSERT INTO moderation_logs (discord_id, action, moderator_id, reason) VALUES (?, ?, ?, ?)`,
    [target.id, action, interaction.user.id, reason || 'No reason'],
  );
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('ban')
    .setDescription('Permanently ban a member')
    .addUserOption((opt) => opt.setName('user').setDescription('Member to ban').setRequired(true))
    .addStringOption((opt) => opt.setName('reason').setDescription('Ban reason')),

  async execute(interaction, client, database, cache) {
    const memberTier = getStaffTier(interaction.member);
    if (memberTier === null || memberTier < 2) {
      return interaction.reply({
        content: '⛔ You need Senior Moderator or higher to use this command.',
        flags: MessageFlags.Ephemeral,
      });
    }

    const target = interaction.options.getUser('user');
    const reason = interaction.options.getString('reason') || 'No reason provided';

    try {
      await interaction.guild.members.ban(target.id, { reason });
      await logModAction(interaction, 'Ban Issued', target, reason);
      return interaction.reply({ content: `🔨 **${target.tag}** has been banned.`, flags: MessageFlags.Ephemeral });
    } catch (error) {
      return interaction.reply({ content: `❌ Failed to ban user: ${error.message}`, flags: MessageFlags.Ephemeral });
    }
  },
};

