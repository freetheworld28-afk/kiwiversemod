const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const { getStartingBalance } = require('../services/economyService');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('balance')
    .setDescription('Check your balance or another user\'s balance')
    .addUserOption((opt) => opt.setName('user').setDescription('User to check (optional)')),

  async execute(interaction, client, database, cache) {
    const target = interaction.options.getUser('user') || interaction.user;
    const db = await database;

    const user = await db.get('SELECT * FROM users WHERE discord_id = ?', [target.id]);
    const balance = user?.balance ?? (await getStartingBalance(database, interaction.guild.id));

    const embed = new EmbedBuilder()
      .setColor(0x57f287)
      .setTitle('💰 Balance')
      .setDescription(`${target.username}'s balance: **${balance}** 🪙`)
      .setThumbnail(target.displayAvatarURL())
      .setTimestamp();

    return interaction.reply({ embeds: [embed] });
  },
};

