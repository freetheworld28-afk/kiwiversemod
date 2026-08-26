'use strict';

const { Events, EmbedBuilder } = require('discord.js');
const { getLogChannel, isEventLoggingEnabled, truncate } = require('../services/loggingService');

module.exports = {
  name: Events.MessageDelete,
  async execute(message, client, database) {
    try {
      const guild = message.guild;
      if (!guild) return;
      if (message.author?.bot) return;

      if (!(await isEventLoggingEnabled(database, guild.id, 'logging.messageDelete'))) return;

      const logsChannel = await getLogChannel(guild, database);
      if (!logsChannel) return;

      const embed = new EmbedBuilder()
        .setColor(0xed4245)
        .setTitle('🗑️ Message Deleted')
        .addFields({ name: 'Channel', value: `${message.channel}`, inline: true })
        .setFooter({ text: `Message ID: ${message.id}` })
        .setTimestamp();

      if (message.author) {
        embed.setAuthor({
          name: `${message.author.tag} (${message.author.id})`,
          iconURL: message.author.displayAvatarURL(),
        });
      }

      if (message.partial || message.content === null || message.content === undefined) {
        embed.addFields({ name: 'Content', value: '*Message was not cached, content unavailable.*' });
      } else {
        embed.addFields({ name: 'Content', value: truncate(message.content) || '*empty*' });
      }

      if (message.attachments?.size > 0) {
        embed.addFields({
          name: `Attachments (${message.attachments.size})`,
          value: truncate(Array.from(message.attachments.values()).map((a) => a.url).join('\n'), 1024),
        });
      }

      await logsChannel.send({ embeds: [embed] }).catch(() => null);
    } catch (error) {
      console.error('Error in messageDelete:', error);
    }
  },
};
