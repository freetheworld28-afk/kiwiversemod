'use strict';

const { Events, EmbedBuilder } = require('discord.js');
const { getLogChannel, isEventLoggingEnabled, truncate } = require('../services/loggingService');

module.exports = {
  name: Events.MessageUpdate,
  async execute(oldMessage, newMessage, client, database) {
    try {
      if (newMessage.partial) {
        newMessage = await newMessage.fetch().catch(() => newMessage);
      }

      const guild = newMessage.guild;
      if (!guild) return;
      if (newMessage.author?.bot) return;

      // Discord also fires this for embed-only updates (e.g. link unfurls) with
      // no actual content change - ignore those.
      if (!oldMessage.partial && !newMessage.partial && oldMessage.content === newMessage.content) return;

      if (!(await isEventLoggingEnabled(database, guild.id, 'logging.messageEdit'))) return;

      const logsChannel = await getLogChannel(guild, database);
      if (!logsChannel) return;

      const embed = new EmbedBuilder()
        .setColor(0xfee75c)
        .setTitle('📝 Message Edited')
        .addFields(
          { name: 'Channel', value: `${newMessage.channel}`, inline: true },
          { name: 'Jump to Message', value: `[Click here](${newMessage.url})`, inline: true },
          {
            name: 'Before',
            value: oldMessage.partial
              ? '*Message was not cached, original content unavailable.*'
              : (truncate(oldMessage.content) || '*empty*'),
          },
          { name: 'After', value: truncate(newMessage.content) || '*empty*' },
        )
        .setFooter({ text: `Message ID: ${newMessage.id}` })
        .setTimestamp();

      if (newMessage.author) {
        embed.setAuthor({
          name: `${newMessage.author.tag} (${newMessage.author.id})`,
          iconURL: newMessage.author.displayAvatarURL(),
        });
      }

      await logsChannel.send({ embeds: [embed] }).catch(() => null);
    } catch (error) {
      console.error('Error in messageUpdate:', error);
    }
  },
};
