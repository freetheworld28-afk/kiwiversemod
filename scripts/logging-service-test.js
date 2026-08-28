'use strict';

// Standalone correctness test for services/loggingService.js.
// Run with: node scripts/logging-service-test.js
//
// Uses a real in-memory SQLite database (guild_settings only - loggingService
// reads settings through settingsService.getSetting/getSettingsByPrefix) and
// fake guild/channel objects with controllable send()/permissionsFor(), so
// every path can be exercised without a real Discord connection: disabled
// logging, no channel configured, missing permission, a successful send, a
// batched burst, and event-suppression dedup.

const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const { PermissionsBitField, PermissionFlagsBits } = require('discord.js');

async function main() {
  const db = await open({ filename: ':memory:', driver: sqlite3.Database });
  await db.exec(`
    CREATE TABLE guild_settings (
      guild_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (guild_id, key)
    );
  `);
  const database = Promise.resolve(db);
  const { setSetting } = require('../services/settingsService');
  const loggingService = require('../services/loggingService');

  function makeChannel({ id, name, allowed = true }) {
    const sent = [];
    return {
      id,
      name,
      isTextBased: () => true,
      permissionsFor: () => new PermissionsBitField(allowed
        ? [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks]
        : [PermissionFlagsBits.ViewChannel]),
      send: async (payload) => { sent.push(payload); return { id: `msg-${sent.length}` }; },
      _sent: sent,
    };
  }

  function makeGuild(id, channels) {
    const cache = new Map(channels.map((c) => [c.id, c]));
    cache.find = (predicate) => Array.from(cache.values()).find(predicate);
    return {
      id,
      members: { me: { id: 'bot-id' } },
      channels: { cache },
    };
  }

  function fakeUser(tag, id) {
    return { tag, id, displayAvatarURL: () => 'https://example.com/avatar.png' };
  }

  console.log('--- Test 1: disabled logging category never sends ---');
  {
    const channel = makeChannel({ id: 'c1', name: 'member-logs' });
    const guild = makeGuild('g1', [channel]);
    await setSetting(database, 'g1', 'logging.messageDelete', false);
    const result = await loggingService.logEvent(guild, database, 'messageDelete', {
      message: { id: 'm1', channel: { toString: () => '#general', name: 'general' }, author: fakeUser('User#1', 'u1'), content: 'hi', partial: false, attachments: new Map() },
    });
    console.log(`  result.reason=${result.reason}, sent=${channel._sent.length}`);
    if (result.delivered !== false || result.reason !== 'disabled' || channel._sent.length !== 0) throw new Error('FAIL: disabled category still sent a message');
  }

  console.log('\n--- Test 2: no log channel configured -> reported, never throws ---');
  {
    const guild = makeGuild('g2', []); // no channels at all, no settings
    const result = await loggingService.logEvent(guild, database, 'messageDelete', {
      message: { id: 'm2', channel: { toString: () => '#general', name: 'general' }, author: fakeUser('User#2', 'u2'), content: 'hi', partial: false, attachments: new Map() },
    });
    console.log(`  result.reason=${result.reason}`);
    if (result.delivered !== false || result.reason !== 'not_configured') throw new Error('FAIL: missing channel should report not_configured');
  }

  console.log('\n--- Test 3: channel exists but bot lacks permission -> reported, never throws ---');
  {
    const channel = makeChannel({ id: 'c3', name: 'message-logs', allowed: false });
    const guild = makeGuild('g3', [channel]);
    const result = await loggingService.logEvent(guild, database, 'messageDelete', {
      message: { id: 'm3', channel: { toString: () => '#general', name: 'general' }, author: fakeUser('User#3', 'u3'), content: 'hi', partial: false, attachments: new Map() },
    });
    console.log(`  result.reason=${result.reason}, missing=${JSON.stringify(result.missing)}`);
    if (result.delivered !== false || result.reason !== 'missing_permission') throw new Error('FAIL: missing permission should be reported precisely');
    if (!result.missing.includes('Send Messages')) throw new Error('FAIL: missing permission list should name Send Messages');
  }

  console.log('\n--- Test 4: channel resolves by name convention and the embed is actually sent ---');
  {
    const channel = makeChannel({ id: 'c4', name: 'message-logs' });
    const guild = makeGuild('g4', [channel]);
    const result = await loggingService.logEvent(guild, database, 'messageDelete', {
      message: { id: 'm4', channel: { toString: () => '#general', name: 'general' }, author: fakeUser('User#4', 'u4'), content: 'hello world', partial: false, attachments: new Map() },
    });
    console.log(`  result.reason=${result.reason}`);
    if (result.reason !== 'queued') throw new Error('FAIL: expected the event to be queued for send');
    await new Promise((resolve) => setTimeout(resolve, 800)); // let the batch window elapse and the queue drain
    console.log(`  channel received ${channel._sent.length} message(s)`);
    if (channel._sent.length !== 1) throw new Error('FAIL: expected exactly one message sent to #message-logs');
    if (!channel._sent[0].embeds?.[0]) throw new Error('FAIL: sent payload should contain an embed');
  }

  console.log('\n--- Test 5: a burst above the batch threshold collapses into fewer messages ---');
  {
    const channel = makeChannel({ id: 'c5', name: 'member-logs' });
    const guild = makeGuild('g5', [channel]);
    const burstSize = 40;
    const promises = [];
    for (let i = 0; i < burstSize; i++) {
      promises.push(loggingService.logEvent(guild, database, 'memberJoin', {
        member: { user: fakeUser(`Burst${i}#0`, `bu${i}`), guild: { memberCount: 100 + i } },
      }));
    }
    await Promise.all(promises);
    await new Promise((resolve) => setTimeout(resolve, 2500)); // let the batch window elapse and the paced queue fully drain
    console.log(`  ${burstSize} events queued -> ${channel._sent.length} actual Discord messages sent`);
    if (channel._sent.length >= burstSize) throw new Error('FAIL: burst should have been batched into fewer messages than events');
    if (channel._sent.length < 1) throw new Error('FAIL: nothing was sent at all');
  }

  console.log('\n--- Test 6: suppression dedupes a bot-initiated action from the generic gateway-event log ---');
  {
    loggingService.markSuppressed('dedupe-test:1');
    const first = loggingService.consumeSuppressed('dedupe-test:1');
    const second = loggingService.consumeSuppressed('dedupe-test:1');
    console.log(`  first consume=${first}, second consume=${second}`);
    if (first !== true) throw new Error('FAIL: first consumeSuppressed should return true');
    if (second !== false) throw new Error('FAIL: suppression should only fire once (second consume should be false)');
  }

  console.log('\n--- Test 7: unknown event type is reported, never throws ---');
  {
    const guild = makeGuild('g7', []);
    const result = await loggingService.logEvent(guild, database, 'notARealEventType', {});
    console.log(`  result.reason=${result.reason}`);
    if (result.delivered !== false || result.reason !== 'unknown_type') throw new Error('FAIL: unknown type should be reported cleanly');
  }

  console.log('\n--- Metrics snapshot ---');
  console.log(loggingService.getMetrics());

  await db.close();
  console.log('\nAll logging-service test assertions passed.');
}

main().catch((error) => {
  console.error('\nLOGGING SERVICE TEST FAILED:', error);
  process.exit(1);
});
