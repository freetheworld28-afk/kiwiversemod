'use strict';

const { SlashCommandBuilder, EmbedBuilder, ChannelType } = require('discord.js');

function formatDate(date) {
  if (!date) return 'Unknown';
  return `<t:${Math.floor(date.getTime() / 1000)}:F>\n<t:${Math.floor(date.getTime() / 1000)}:R>`;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('serverinfo')
    .setDescription('Show detailed information and statistics about this server'),

  async execute(interaction) {
    const guild = interaction.guild;
    if (!guild) return interaction.reply({ content: 'This command can only be used in a server.', ephemeral: true });

    await interaction.deferReply();

    await guild.members.fetch().catch(() => null);

    const members = guild.members.cache;
    const humans = members.filter((m) => !m.user.bot).size;
    const bots = members.filter((m) => m.user.bot).size;
    const online = members.filter((m) => ['online', 'idle', 'dnd'].includes(m.presence?.status)).size;

    const channels = guild.channels.cache;
    const textChannels = channels.filter((c) => c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement).size;
    const voiceChannels = channels.filter((c) => c.type === ChannelType.GuildVoice || c.type === ChannelType.GuildStageVoice).size;
    const categories = channels.filter((c) => c.type === ChannelType.GuildCategory).size;

    const roles = guild.roles.cache.filter((r) => r.id !== guild.id).size;
    const emojis = guild.emojis.cache.size;
    const stickers = guild.stickers.cache.size;
    const boosts = guild.premiumSubscriptionCount || 0;
    const boostTier = guild.premiumTier || 0;

    const owner = await guild.fetchOwner().catch(() => null);

    const embed = new EmbedBuilder()
      .setColor(0x8b5cf6)
      .setTitle(`📊 ${guild.name} — Server Info`)
      .setThumbnail(guild.iconURL({ size: 256 }) || null)
      .addFields(
        { name: '👑 Owner', value: owner ? `${owner.user.tag}\n<@${owner.id}>` : 'Unknown', inline: true },
        { name: '🆔 Server ID', value: guild.id, inline: true },
        { name: '📅 Created', value: formatDate(guild.createdAt), inline: false },
        { name: '👥 Members', value: `**Total:** ${guild.memberCount}\n**Humans:** ${humans}\n**Bots:** ${bots}\n**Online:** ${online}`, inline: true },
        { name: '💬 Channels', value: `**Text:** ${textChannels}\n**Voice:** ${voiceChannels}\n**Categories:** ${categories}\n**Total:** ${channels.size}`, inline: true },
        { name: '🏷️ Server', value: `**Roles:** ${roles}\n**Emojis:** ${emojis}\n**Stickers:** ${stickers}`, inline: true },
        { name: '🚀 Boosts', value: `**Level:** ${boostTier}\n**Boosts:** ${boosts}`, inline: true },
        { name: '🔐 Verification', value: String(guild.verificationLevel), inline: true },
        { name: '🌐 Preferred Locale', value: guild.preferredLocale || 'Unknown', inline: true },
      )
      .setFooter({ text: `Requested by ${interaction.user.tag}` })
      .setTimestamp();

    if (guild.bannerURL()) embed.setImage(guild.bannerURL({ size: 1024 }));

    return interaction.editReply({ embeds: [embed] });
  },
};
