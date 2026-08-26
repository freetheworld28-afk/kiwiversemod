'use strict';

const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('autoresponse')
    .setDescription('Manage KiwiVerse automatic responses')
    .addSubcommand((sub) => sub
      .setName('add')
      .setDescription('Add or update an automatic response')
      .addStringOption((opt) => opt.setName('trigger').setDescription('Text that triggers the response').setRequired(true).setMaxLength(100))
      .addStringOption((opt) => opt.setName('response').setDescription('Bot response').setRequired(true).setMaxLength(1500)))
    .addSubcommand((sub) => sub
      .setName('remove')
      .setDescription('Remove an automatic response')
      .addStringOption((opt) => opt.setName('trigger').setDescription('Trigger to remove').setRequired(true)))
    .addSubcommand((sub) => sub.setName('list').setDescription('List automatic responses')),

  async execute(interaction, client, database) {
    const db = await database;
    const sub = interaction.options.getSubcommand();

    if (sub === 'list') {
      const rows = await db.all('SELECT trigger, response FROM autoresponses WHERE guild_id = ? ORDER BY trigger LIMIT 50', interaction.guild.id);
      const lines = rows.length ? rows.map((r) => `• \`${r.trigger}\` → ${r.response.slice(0, 120)}`).join('\n') : 'No automatic responses configured.';
      return interaction.reply({ embeds: [new EmbedBuilder().setColor(0x8b5cf6).setTitle('💬 Automatic Responses').setDescription(lines)] });
    }

    if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
      return interaction.reply({ content: '⛔ You need Manage Server to change automatic responses.', flags: MessageFlags.Ephemeral });
    }

    const trigger = interaction.options.getString('trigger').trim().toLowerCase();
    if (sub === 'remove') {
      const result = await db.run('DELETE FROM autoresponses WHERE guild_id = ? AND lower(trigger) = ?', interaction.guild.id, trigger);
      return interaction.reply({ content: result.changes ? `🗑️ Removed auto-response for \`${trigger}\`.` : 'That trigger was not found.', flags: MessageFlags.Ephemeral });
    }

    const response = interaction.options.getString('response').trim();
    const existing = await db.get('SELECT id FROM autoresponses WHERE guild_id = ? AND lower(trigger) = ?', interaction.guild.id, trigger);
    if (existing) {
      await db.run('UPDATE autoresponses SET response = ? WHERE id = ?', response, existing.id);
    } else {
      await db.run('INSERT INTO autoresponses (trigger, response, guild_id) VALUES (?, ?, ?)', trigger, response, interaction.guild.id);
    }
    return interaction.reply({ content: `✅ Auto-response saved for \`${trigger}\`.`, flags: MessageFlags.Ephemeral });
  },
};
