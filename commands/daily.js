'use strict';

const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const { getSetting } = require('../services/settingsService');
const { claimDaily } = require('../services/economyService');

module.exports = {
  data: new SlashCommandBuilder().setName('daily').setDescription('Claim your daily KiwiVerse currency reward'),

  async execute(interaction, client, database) {
    const cooldown = 24 * 60 * 60 * 1000;
    const reward = Number(await getSetting(database, interaction.guild.id, 'economy.dailyReward', 250)) || 250;

    const outcome = await claimDaily(
      database,
      interaction.guild.id,
      interaction.user.id,
      interaction.user.username,
      reward,
      cooldown,
    );

    if (!outcome.claimed) {
      const last = outcome.lastDaily ? new Date(outcome.lastDaily).getTime() : 0;
      const next = Math.floor((last + cooldown) / 1000);
      return interaction.reply({ content: `⏰ You already claimed your daily reward. Come back <t:${next}:R>.`, flags: MessageFlags.Ephemeral });
    }

    return interaction.reply({ embeds: [new EmbedBuilder()
      .setColor(0x57f287)
      .setTitle('🎁 Daily Reward Claimed')
      .setDescription(`You received **${reward.toLocaleString()}** 🪙`)
      .addFields({ name: 'New balance', value: `**${outcome.balance.toLocaleString()}** 🪙` })
      .setTimestamp()] });
  },
};
