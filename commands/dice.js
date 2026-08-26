'use strict';

const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const { applyBalanceDelta } = require('../services/economyService');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('dice')
    .setDescription('Bet on a dice roll')
    .addIntegerOption((opt) => opt.setName('amount').setDescription('Coins to bet').setRequired(true).setMinValue(1))
    .addIntegerOption((opt) => opt.setName('guess').setDescription('Guess 1-6').setRequired(true).setMinValue(1).setMaxValue(6)),

  async execute(interaction, client, database) {
    const amount = interaction.options.getInteger('amount');
    const guess = interaction.options.getInteger('guess');

    // Debit the bet up front - refused atomically if the balance can't cover
    // it, so a broke user can't win a bet they were never able to place.
    const debit = await applyBalanceDelta(database, interaction.guild.id, interaction.user.id, interaction.user.username, -amount);
    if (!debit.applied) {
      return interaction.reply({ content: `❌ You only have **${debit.balance}** 🪙.`, flags: MessageFlags.Ephemeral });
    }

    const rolled = Math.floor(Math.random() * 6) + 1;
    const won = rolled === guess;

    let newBalance = debit.balance;
    let change = -amount;
    if (won) {
      // Return the stake plus 5x winnings.
      change = amount * 5;
      const credit = await applyBalanceDelta(database, interaction.guild.id, interaction.user.id, interaction.user.username, amount + change);
      newBalance = credit.balance;
    }

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
