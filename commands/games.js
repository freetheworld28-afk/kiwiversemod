const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');

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
    const db = await database;

    const user = await db.get('SELECT * FROM users WHERE discord_id = ?', [interaction.user.id]);
    const balance = user?.balance || 1000;

    if (balance < amount) {
      return interaction.reply({
        content: `❌ You don't have enough coins! You have **${balance}** 🪙`,
        flags: MessageFlags.Ephemeral,
      });
    }

    const result = Math.random() > 0.5 ? 'heads' : 'tails';
    const won = choice === result;
    const newBalance = won ? balance + amount : balance - amount;

    await db.run(
      `INSERT INTO users (discord_id, balance) VALUES (?, ?) ON CONFLICT(discord_id) DO UPDATE SET balance = excluded.balance`,
      [interaction.user.id, newBalance],
    );

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

