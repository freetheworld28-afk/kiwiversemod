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

  function makeChannel({ id, name, allowed = true, isThread = false, textBased = true, extraGrants = [] }) {
    const sent = [];
    const grants = allowed
      ? [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.EmbedLinks, ...(isThread ? [PermissionFlagsBits.SendMessagesInThreads] : [PermissionFlagsBits.SendMessages]), ...extraGrants]
      : [PermissionFlagsBits.ViewChannel];
    return {
      id,
      name,
      isTextBased: () => textBased,
      isThread: () => isThread,
      permissionsFor: () => new PermissionsBitField(grants),
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

  console.log('\n--- Test 8: a configured channel that was deleted falls back instead of crashing ---');
  {
    // logging.messageChannelId points at a channel ID that isn't in the
    // guild's cache at all (simulating deletion) - a real fallback channel
    // is also present, so this proves the fallback chain kicks in rather
    // than just failing outright.
    const fallback = makeChannel({ id: 'c8-fallback', name: 'message-logs' });
    const guild = makeGuild('g8', [fallback]);
    await setSetting(database, 'g8', 'logging.messageChannelId', 'deleted-channel-id-999');
    const result = await loggingService.logEvent(guild, database, 'messageDelete', {
      message: { id: 'm8', channel: { toString: () => '#general', name: 'general' }, author: fakeUser('User#8', 'u8'), content: 'hi', partial: false, attachments: new Map() },
    });
    console.log(`  result.reason=${result.reason} (configured channel missing, should still resolve via name fallback)`);
    if (result.reason !== 'queued') throw new Error('FAIL: a deleted configured channel should fall back to the named channel, not fail outright');
    await new Promise((resolve) => setTimeout(resolve, 800));
    if (fallback._sent.length !== 1) throw new Error('FAIL: the fallback channel never received the log after the configured one was missing');
  }

  console.log('\n--- Test 9: a thread log channel is checked for Send Messages in Threads, not Send Messages ---');
  {
    const thread = makeChannel({ id: 'c9', name: 'member-logs-thread', isThread: true, allowed: false });
    const guild = makeGuild('g9', [thread]);
    await setSetting(database, 'g9', 'logging.memberChannelId', 'c9');
    const result = await loggingService.logEvent(guild, database, 'memberJoin', {
      member: { user: fakeUser('ThreadUser#1', 'tu1'), guild: { memberCount: 10 } },
    });
    console.log(`  result.reason=${result.reason}, missing=${JSON.stringify(result.missing)}`);
    if (result.reason !== 'missing_permission') throw new Error('FAIL: expected a missing-permission result for the thread');
    if (!result.missing.includes('Send Messages in Threads')) throw new Error('FAIL: a thread should report "Send Messages in Threads", not "Send Messages"');
    if (result.missing.includes('Send Messages')) throw new Error('FAIL: a thread should not report the non-thread "Send Messages" permission');
  }

  console.log('\n--- Test 10: a forum channel (not directly sendable) is excluded, falls back instead of crashing ---');
  {
    const forum = makeChannel({ id: 'c10-forum', name: 'member-logs', textBased: false });
    const fallback = makeChannel({ id: 'c10-fallback', name: 'default-logs' });
    const guild = makeGuild('g10', [forum, fallback]);
    const result = await loggingService.logEvent(guild, database, 'memberJoin', {
      member: { user: fakeUser('ForumUser#1', 'fu1'), guild: { memberCount: 11 } },
    });
    console.log(`  result.reason=${result.reason} (forum channel named member-logs should be skipped for default-logs)`);
    if (result.reason !== 'queued') throw new Error('FAIL: should have fallen back past the non-text forum channel to default-logs');
    await new Promise((resolve) => setTimeout(resolve, 800));
    if (fallback._sent.length !== 1) throw new Error('FAIL: default-logs fallback never received the event');
    if (forum._sent.length !== 0) throw new Error('FAIL: a forum channel should never receive a direct send() attempt');
  }

  console.log('\n--- Test 11: 100 logging events across many channels stay controlled ---');
  {
    const channels = Array.from({ length: 10 }, (_, i) => makeChannel({ id: `c11-${i}`, name: `member-logs-${i}` }));
    const guilds = channels.map((ch, i) => makeGuild(`g11-${i}`, [ch]));
    for (let i = 0; i < guilds.length; i++) {
      await setSetting(database, guilds[i].id, 'logging.memberChannelId', channels[i].id);
    }
    const promises = [];
    for (let i = 0; i < 100; i++) {
      const idx = i % guilds.length;
      promises.push(loggingService.logEvent(guilds[idx], database, 'memberJoin', {
        member: { user: fakeUser(`LoadUser${i}#0`, `lu${i}`), guild: { memberCount: 100 + i } },
      }));
    }
    const results = await Promise.all(promises);
    await new Promise((resolve) => setTimeout(resolve, 2500));
    const totalSent = channels.reduce((sum, ch) => sum + ch._sent.length, 0);
    console.log(`  100 events across ${guilds.length} guild channels -> ${totalSent} total Discord messages sent (queued=${results.filter((r) => r.reason === 'queued').length})`);
    if (results.some((r) => r.delivered === false && r.reason !== 'queued')) throw new Error('FAIL: some events in the 100-event load were rejected unexpectedly');
    if (totalSent >= 100) throw new Error('FAIL: 100 events spread over 10 channels should still batch per channel, not send 1:1');
    if (totalSent < 10) throw new Error('FAIL: every channel should have received at least one message');
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
