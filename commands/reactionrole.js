'use strict';

const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder, MessageFlags } = require('discord.js');
const reactionRoleService = require('../services/reactionRoleService');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('reactionrole')
    .setDescription('Manage reaction roles')
    .addSubcommand((sub) => sub
      .setName('add')
      .setDescription('Bind an emoji reaction on a message to a role')
      .addStringOption((opt) => opt.setName('message_id').setDescription('ID of the message to react to').setRequired(true))
      .addStringOption((opt) => opt.setName('emoji').setDescription('Emoji to react with').setRequired(true))
      .addRoleOption((opt) => opt.setName('role').setDescription('Role to grant').setRequired(true))
      .addChannelOption((opt) => opt.setName('channel').setDescription('Channel the message is in (defaults to this channel)')))
    .addSubcommand((sub) => sub
      .setName('remove')
      .setDescription('Remove a reaction role binding')
      .addStringOption((opt) => opt.setName('message_id').setDescription('ID of the message').setRequired(true))
      .addStringOption((opt) => opt.setName('emoji').setDescription('Emoji to unbind').setRequired(true)))
    .addSubcommand((sub) => sub
      .setName('list')
      .setDescription('List reaction role bindings for a message')
      .addStringOption((opt) => opt.setName('message_id').setDescription('ID of the message').setRequired(true))),

  async execute(interaction, client, database) {
    if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
      return interaction.reply({ content: '⛔ You need Manage Server to manage reaction roles.', flags: MessageFlags.Ephemeral });
    }

    const sub = interaction.options.getSubcommand();
    const messageId = interaction.options.getString('message_id');

    if (sub === 'add') {
      const emojiInput = interaction.options.getString('emoji');
      const role = interaction.options.getRole('role');
      const channel = interaction.options.getChannel('channel') || interaction.channel;

      if (role.managed || role.id === interaction.guild.roles.everyone.id) {
        return interaction.reply({ content: '❌ That role can\'t be assigned - pick a normal, unmanaged role.', flags: MessageFlags.Ephemeral });
      }

      const botMember = interaction.guild.members.me;
      if (botMember.roles.highest.position <= role.position) {
        return interaction.reply({ content: '❌ I can\'t assign that role - it\'s above my highest role. Move my role above it first.', flags: MessageFlags.Ephemeral });
      }

      if (!channel?.isTextBased()) {
        return interaction.reply({ content: '❌ That channel is not a text channel.', flags: MessageFlags.Ephemeral });
      }

      const message = await channel.messages.fetch(messageId).catch(() => null);
      if (!message) {
        return interaction.reply({ content: `❌ Could not find message \`${messageId}\` in ${channel}.`, flags: MessageFlags.Ephemeral });
      }

      const reacted = await message.react(emojiInput).catch(() => null);
      if (!reacted) {
        return interaction.reply({ content: '❌ I couldn\'t react with that emoji - make sure it\'s a valid emoji I have access to.', flags: MessageFlags.Ephemeral });
      }

      const emojiKey = reactionRoleService.normalizeEmoji(emojiInput);
      await reactionRoleService.addBinding(database, interaction.guild.id, message.id, emojiKey, role.id);

      return interaction.reply({ content: `✅ Reacting with ${emojiInput} on [that message](${message.url}) now grants ${role}.`, flags: MessageFlags.Ephemeral });
    }

    if (sub === 'remove') {
      const emojiInput = interaction.options.getString('emoji');
      const emojiKey = reactionRoleService.normalizeEmoji(emojiInput);
      const removed = await reactionRoleService.removeBinding(database, interaction.guild.id, messageId, emojiKey);
      return interaction.reply({ content: removed ? '✅ Reaction role binding removed.' : '⚠️ No matching binding found for that message and emoji.', flags: MessageFlags.Ephemeral });
    }

    // list
    const bindings = await reactionRoleService.listBindings(database, interaction.guild.id, messageId);
    if (!bindings.length) {
      return interaction.reply({ content: 'No reaction roles configured for that message.', flags: MessageFlags.Ephemeral });
    }
    const lines = bindings.map((b) => `${b.emoji} → <@&${b.role_id}>`).join('\n');
    return interaction.reply({
      embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle('🎭 Reaction Roles').setDescription(lines)],
      flags: MessageFlags.Ephemeral,
    });
  },
};
