'use strict';

const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const reminderService = require('../services/reminderService');

function parseDuration(input) {
  const match = /^\s*(\d+)\s*([mhdw])\s*$/i.exec(input || '');
  if (!match) return null;
  const value = Number(match[1]);
  const unit = match[2].toLowerCase();
  const factor = unit === 'm' ? 60000 : unit === 'h' ? 3600000 : unit === 'd' ? 86400000 : 604800000;
  return value > 0 ? value * factor : null;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('reminder')
    .setDescription('Create or view your reminders')
    .addSubcommand((sub) => sub
      .setName('set')
      .setDescription('Set a reminder')
      .addStringOption((opt) => opt.setName('in').setDescription('When, e.g. 30m, 2h, 3d, 1w').setRequired(true))
      .addStringOption((opt) => opt.setName('message').setDescription('What should I remind you about?').setRequired(true).setMaxLength(1500)))
    .addSubcommand((sub) => sub.setName('list').setDescription('List your pending reminders')),

  async execute(interaction, client, database) {
    const sub = interaction.options.getSubcommand();
    const db = await database;
    await reminderService.ensureSchema(database);

    if (sub === 'list') {
      const rows = await db.all('SELECT id, message, due_at FROM reminders WHERE user_id = ? AND delivered_at IS NULL ORDER BY due_at ASC LIMIT 20', interaction.user.id);
      const lines = rows.length ? rows.map((r) => `**#${r.id}** • <t:${Math.floor(new Date(r.due_at).getTime()/1000)}:R> • ${r.message.slice(0, 150)}`).join('\n') : 'You have no pending reminders.';
      return interaction.reply({ embeds: [new EmbedBuilder().setColor(0x8b5cf6).setTitle('⏰ Your Reminders').setDescription(lines)], flags: MessageFlags.Ephemeral });
    }

    const duration = parseDuration(interaction.options.getString('in'));
    if (!duration || duration > 365 * 86400000) {
      return interaction.reply({ content: 'Use a duration like `30m`, `2h`, `3d`, or `1w` (maximum 365 days).', flags: MessageFlags.Ephemeral });
    }

    const reminder = await reminderService.create(client, database, {
      userId: interaction.user.id,
      guildId: interaction.guild?.id,
      channelId: interaction.channelId,
      message: interaction.options.getString('message'),
      dueAt: Date.now() + duration,
    });
    return interaction.reply({ content: `✅ Reminder **#${reminder.id}** set for <t:${Math.floor(new Date(reminder.due_at).getTime()/1000)}:F> (<t:${Math.floor(new Date(reminder.due_at).getTime()/1000)}:R>). I’ll DM you.`, flags: MessageFlags.Ephemeral });
  },
};
