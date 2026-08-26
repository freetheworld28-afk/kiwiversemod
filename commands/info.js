const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { getStartingBalance } = require('../services/economyService');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('info')
    .setDescription('Get information about a user')
    .addUserOption((opt) => opt.setName('user').setDescription('User to check (optional)')),

  async execute(interaction, client, database, cache) {
    const target = interaction.options.getUser('user') || interaction.user;
    const db = await database;

    const userData = await db.get('SELECT * FROM users WHERE discord_id = ?', [target.id]);
    const balance = userData?.balance ?? (await getStartingBalance(database, interaction.guild.id));

    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle(`${target.username}'s Profile`)
      .setThumbnail(target.displayAvatarURL())
      .addFields(
        { name: 'Level', value: `${userData?.level || 0}`, inline: true },
        { name: 'XP', value: `${userData?.xp || 0}`, inline: true },
        { name: 'Balance', value: `${balance} 🪙`, inline: true },
        { name: 'Warnings', value: `${userData?.warnings || 0}`, inline: true },
        {
          name: 'Member Since',
          value: new Date(userData?.created_at || Date.now()).toLocaleDateString(),
          inline: true,
        },
      )
      .setTimestamp();

    return interaction.reply({ embeds: [embed] });
  },
};

