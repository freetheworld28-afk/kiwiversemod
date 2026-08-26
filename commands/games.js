const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const { applyBalanceDelta } = require('../services/economyService');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('coinflip')
    .setDescription('Flip a coin and earn or lose coins')
    .addIntegerOption((opt) =>
      opt.setName('amount').setDescription('Amount to bet').setRequired(true).setMinValue(1),
    )
    .addStringOption((opt) =>
      opt.setName('choice').setDescription('Heads or Tails').setRequired(true).addChoices(
        { name: 'Heads', value: 'heads' },
        { name: 'Tails', value: 'tails' },
      ),
    ),

  async execute(interaction, client, database, cache) {
    const amount = interaction.options.getInteger('amount');
    const choice = interaction.options.getString('choice');

    // Debit the bet up front - refused atomically if the balance can't cover
    // it, so a broke user can't win a bet they were never able to place.
    const debit = await applyBalanceDelta(database, interaction.guild.id, interaction.user.id, interaction.user.username, -amount);
    if (!debit.applied) {
      return interaction.reply({
        content: `❌ You don't have enough coins! You have **${debit.balance}** 🪙`,
        flags: MessageFlags.Ephemeral,
      });
    }

    const result = Math.random() > 0.5 ? 'heads' : 'tails';
    const won = choice === result;

    let newBalance = debit.balance;
    if (won) {
      // Return the stake plus the winnings.
      const credit = await applyBalanceDelta(database, interaction.guild.id, interaction.user.id, interaction.user.username, amount * 2);
      newBalance = credit.balance;
    }

    const embed = new EmbedBuilder()
      .setColor(won ? 0x57f287 : 0xed4245)
      .setTitle(won ? '🎉 You won!' : '😢 You lost!')
      .setDescription(`Coin landed on **${result}**`)
      .addFields(
        { name: 'Bet Amount', value: `${amount} 🪙`, inline: true },
        { name: 'Result', value: won ? `+${amount} 🪙` : `-${amount} 🪙`, inline: true },
        { name: 'New Balance', value: `${newBalance} 🪙`, inline: true },
      )
      .setTimestamp();

    return interaction.reply({ embeds: [embed] });
  },
};
