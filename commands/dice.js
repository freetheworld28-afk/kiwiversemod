'use strict';

const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('dice')
    .setDescription('Bet on a dice roll')
    .addIntegerOption((opt) => opt.setName('amount').setDescription('Coins to bet').setRequired(true).setMinValue(1))
    .addIntegerOption((opt) => opt.setName('guess').setDescription('Guess 1-6').setRequired(true).setMinValue(1).setMaxValue(6)),

  async execute(interaction, client, database) {
    const amount = interaction.options.getInteger('amount');
    const guess = interaction.options.getInteger('guess');
    const db = await database;
    const row = await db.get('SELECT balance FROM users WHERE discord_id = ?', interaction.user.id);
    const balance = row?.balance ?? 1000;
    if (amount > balance) return interaction.reply({ content: `❌ You only have **${balance}** 🪙.`, flags: MessageFlags.Ephemeral });

    const rolled = Math.floor(Math.random() * 6) + 1;
    const won = rolled === guess;
    const change = won ? amount * 5 : -amount;
    const newBalance = balance + change;
    await db.run(
      `INSERT INTO users (discord_id, username, balance) VALUES (?, ?, ?)
       ON CONFLICT(discord_id) DO UPDATE SET username = excluded.username, balance = excluded.balance`,
      interaction.user.id,
      interaction.user.username,
      newBalance,
    );

    return interaction.reply({ embeds: [new EmbedBuilder()
      .setColor(won ? 0x57f287 : 0xed4245)
      .setTitle(won ? '🎲 Jackpot!' : '🎲 Dice Roll')
      .setDescription(`You guessed **${guess}** and rolled **${rolled}**.`)
      .addFields(
        { name: 'Result', value: `${change >= 0 ? '+' : ''}${change.toLocaleString()} 🪙`, inline: true },
        { name: 'Balance', value: `${newBalance.toLocaleString()} 🪙`, inline: true },
      )
      .setTimestamp()] });
  },
};
