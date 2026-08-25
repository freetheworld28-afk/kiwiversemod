'use strict';

const { Events } = require('discord.js');
const inviteTracker = require('../services/inviteTrackerService');

module.exports = {
  name: Events.GuildMemberRemove,
  async execute(member, client, database) {
    try {
      await inviteTracker.handleMemberRemove(member, database);
    } catch (error) {
      console.error('Invite tracker member-remove error:', error);
    }
  },
};
