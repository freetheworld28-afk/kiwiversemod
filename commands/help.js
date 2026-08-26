const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('help')
    .setDescription('See KiwiVerse commands and systems'),

  async execute(interaction) {
    const embed = new EmbedBuilder()
      .setColor(0x8b5cf6)
      .setTitle('🌟 KiwiVerse — All-in-One Bot')
      .setDescription('Use the commands below to manage and use the server. Some management commands require staff permissions.')
      .addFields(
        { name: '🛡️ Moderation', value: '`/ban` `/kick` `/timeout` `/warn` `/warnings`' },
        { name: '💰 Economy', value: '`/balance` `/daily` `/coinflip` `/dice` `/moneytop` `/shop`' },
        { name: '📊 Leveling', value: '`/rank` `/leaderboard` `/profile`' },
        { name: '🎫 Tickets & Applications', value: '`/ticket` `/apply`' },
        { name: '🎟️ Invites & Events', value: '`/invites` `/inviteleaderboard` `/inviteevent`' },
        { name: '🎮 Roblox', value: '`/roblox` — link and manage up to 10 Roblox accounts' },
        { name: '🔧 Utility', value: '`/info` `/serverinfo` `/reminder` `/autoresponse` `/help`' },
      )
      .setFooter({ text: 'KiwiVerse • More modules are being added to the all-in-one system' })
      .setTimestamp();

    return interaction.reply({ embeds: [embed] });
  },
};
