'use strict';

const levelingService = require('../services/levelingService');

module.exports = {
  name: 'leveling',
  async onMessage(message, client, database) {
    await levelingService.handleMessage(message, client, database);
  },
};
