'use strict';

const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const giveawayService = require('../services/giveawayService');
const { getSetting } = require('../services/settingsService');

function parseDuration(text) {
  const match = /^(\d+)\s*(s|m|h|d|w)$/i.exec(String(text).trim());
  if (!match) return null;
  const multipliers = { s: 1000, m: 60000, h: 3600000, d: 86400000, w: 604800000 };
  return Number(match[1]) * multipliers[match[2].toLowerCase()];
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('giveaway')
    .setDescription('Run a giveaway')
    .addSubcommand((sub) => sub
      .setName('start')
      .setDescription('Start a new giveaway')
      .addStringOption((opt) => opt.setName('prize').setDescription('What are you giving away?').setRequired(true).setMaxLength(200))
      .addStringOption((opt) => opt.setName('duration').setDescription('How long it runs, e.g. 30m, 2h, 1d').setRequired(true))
      .addIntegerOption((opt) => opt.setName('winners').setDescription('Number of winners (default 1)').setMinValue(1).setMaxValue(20))
      .addChannelOption((opt) => opt.setName('channel').setDescription('Channel to post in (defaults to this channel)')))
    .addSubcommand((sub) => sub
      .setName('end')
      .setDescription('End a giveaway early and draw winners')
      .addIntegerOption((opt) => opt.setName('id').setDescription('Giveaway ID').setRequired(true)))
    .addSubcommand((sub) => sub
      .setName('reroll')
      .setDescription('Reroll winners for an ended giveaway')
      .addIntegerOption((opt) => opt.setName('id').setDescription('Giveaway ID').setRequired(true))),

  async execute(interaction, client, database) {
    if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
      return interaction.reply({ content: '⛔ You need Manage Server to run giveaways.', flags: MessageFlags.Ephemeral });
    }

    const sub = interaction.options.getSubcommand();

    if (sub === 'start') {
      const enabled = await getSetting(database, interaction.guild.id, 'giveaways.enabled', true);
      if (!enabled) {
        return interaction.reply({ content: '❌ Giveaways are currently disabled on this server.', flags: MessageFlags.Ephemeral });
      }

      const prize = interaction.options.getString('prize');
      const durationText = interaction.options.getString('duration');
      const winnersCount = interaction.options.getInteger('winners') || 1;
      const channel = interaction.options.getChannel('channel') || interaction.channel;

      const durationMs = parseDuration(durationText);
      if (!durationMs || durationMs < 10_000) {
        return interaction.reply({ content: '❌ Invalid duration. Use a value like `30m`, `2h`, `1d` (minimum 10 seconds).', flags: MessageFlags.Ephemeral });
      }
      if (!channel?.isTextBased()) {
        return interaction.reply({ content: '❌ That channel is not a text channel.', flags: MessageFlags.Ephemeral });
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const giveaway = await giveawayService.start(interaction, database, { prize, durationMs, winnersCount, channel });
      if (!giveaway) {
        return interaction.editReply({ content: '❌ I could not post the giveaway - check my permissions in that channel.' });
      }
      return interaction.editReply({ content: `🎉 Giveaway #${giveaway.id} started in ${channel}!` });
    }

    const id = interaction.options.getInteger('id');
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const result = await giveawayService.endGiveaway(interaction.client, database, id, { reroll: sub === 'reroll' });
    if (!result) {
      return interaction.editReply({ content: `❌ Giveaway #${id} not found.` });
    }
    return interaction.editReply({ content: sub === 'reroll' ? `🔁 Giveaway #${id} rerolled.` : `🏁 Giveaway #${id} ended.` });
  },
};
