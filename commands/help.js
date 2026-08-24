const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('help')
    .setDescription('Get help with available commands'),

  async execute(interaction, client, database, cache) {
    const categories = {
      '🛡️ Moderation': ['ban', 'kick', 'timeout'],
      '💰 Economy': ['balance', 'daily'],
      '🎮 Games': ['coinflip', 'dice'],
      '👤 User': ['info', 'profile'],
      '📋 Utility': ['help', 'suggestions'],
    };

    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle('🤖 KiwiVerse Bot Help')
      .setDescription('Here are all available commands:');

    for (const [category, commands] of Object.entries(categories)) {
      embed.addFields({
        name: category,
        value: `\`${commands.join('` `')}\``,
        inline: false,
      });
    }

    embed.setFooter({ text: 'Use /command for more details' }).setTimestamp();

    return interaction.reply({ embeds: [embed] });
  },
};

