'use strict';

const { SlashCommandBuilder } = require('discord.js');
const suggestionService = require('../services/suggestionService');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('suggest')
    .setDescription('Submit a suggestion for the server')
    .addStringOption((opt) => opt.setName('idea').setDescription('Your suggestion').setRequired(true).setMaxLength(1000)),

  async execute(interaction, client, database) {
    const idea = interaction.options.getString('idea');
    return suggestionService.create(interaction, database, idea);
  },
};
