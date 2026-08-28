'use strict';

// Standalone load/correctness test for services/levelingService.js.
// Run with: node scripts/leveling-load-test.js
//
// Uses a real in-memory SQLite database (no Discord connection needed) and
// fake message/guild objects, instruments db.get/db.run to count actual
// database round-trips, and fires bursts of concurrent "messages" to prove:
//   - no SQLite read/write happens on the per-message hot path
//   - the per-user cooldown holds even under concurrent bursts
//   - concurrent messages from the same/different users never lose an update
//   - a batch flush persists everything correctly in one transaction

const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

async function main() {
  const db = await open({ filename: ':memory:', driver: sqlite3.Database });
  await db.exec(`
    CREATE TABLE users (
      discord_id TEXT PRIMARY KEY,
      username TEXT,
      xp INTEGER DEFAULT 0,
      level INTEGER DEFAULT 0,
      balance INTEGER DEFAULT 1000,
      last_message TIMESTAMP,
      last_daily TIMESTAMP,
      warnings INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE guild_settings (
      guild_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (guild_id, key)
    );
  `);

  let reads = 0;
  let writes = 0;
  const originalGet = db.get.bind(db);
  const originalRun = db.run.bind(db);
  db.get = (...args) => {
    if (/^\s*SELECT/i.test(args[0])) reads++;
    return originalGet(...args);
  };
  db.run = (...args) => {
    if (/^\s*(INSERT|UPDATE|DELETE)/i.test(args[0])) writes++;
    return originalRun(...args);
  };

  const database = Promise.resolve(db);
  const levelingService = require('../services/levelingService');

  const GUILD_ID = 'guild-1';
  function fakeMessage(userId, username) {
    return {
      author: { id: userId, username, bot: false },
      guild: { id: GUILD_ID, name: 'Test Guild', channels: { cache: new Map() } },
      channel: { id: 'chan-1', isTextBased: () => true, send: async () => ({}) },
      member: { roles: { cache: { some: () => false } } },
      react: async () => null,
    };
  }

  console.log('--- Test 1: per-message hot path does no SQLite I/O ---');
  const usersInBurst = 200;
  const messagesPerUser = 5; // only the first of each user's burst should count (cooldown)
  const tasks = [];
  for (let u = 0; u < usersInBurst; u++) {
    const userId = `user-${u}`;
    for (let m = 0; m < messagesPerUser; m++) {
      tasks.push(levelingService.handleMessage(fakeMessage(userId, `User${u}`), null, database));
    }
  }
  const startReads = reads;
  const startWrites = writes;
  await Promise.all(tasks);
  console.log(`  ${usersInBurst * messagesPerUser} messages processed across ${usersInBurst} users`);
  console.log(`  SQLite reads during burst: ${reads - startReads} (expected: <= ${usersInBurst}, one lazy-load per distinct user)`);
  console.log(`  SQLite writes during burst: ${writes - startWrites} (expected: 0 - writes only happen on flush)`);
  if (writes - startWrites !== 0) throw new Error('FAIL: a write happened on the per-message path');
  if (reads - startReads > usersInBurst) throw new Error('FAIL: more reads than distinct users - cache is not working');

  console.log('\n--- Test 2: cooldown holds under a concurrent same-user burst ---');
  const raceUserId = 'race-user';
  const concurrentMessages = 50;
  await Promise.all(
    Array.from({ length: concurrentMessages }, () => levelingService.handleMessage(fakeMessage(raceUserId, 'RaceUser'), null, database)),
  );
  const metricsAfterRace = levelingService.getMetrics();
  console.log(`  Fired ${concurrentMessages} concurrent messages from one user`);
  console.log(`  Cumulative XP awarded so far: ${metricsAfterRace.xpAwarded}`);

  console.log('\n--- Test 3: flush persists everything in one batch, then cache is consistent with DB ---');
  const beforeFlushWrites = writes;
  const result = await levelingService.flush(database);
  const afterFlushWrites = writes;
  console.log(`  Flushed ${result.flushed} dirty user(s)`);
  console.log(`  SQLite write statements issued by the flush: ${afterFlushWrites - beforeFlushWrites} (one per dirty user, inside a single transaction)`);

  const rows = await db.all('SELECT discord_id, xp, level FROM users ORDER BY discord_id');
  console.log(`  Rows persisted: ${rows.length} (expected ${usersInBurst + 1})`);
  if (rows.length !== usersInBurst + 1) throw new Error(`FAIL: expected ${usersInBurst + 1} persisted users, got ${rows.length}`);

  const raceRow = rows.find((r) => r.discord_id === raceUserId);
  console.log(`  race-user persisted xp: ${raceRow.xp} (should be a single award, 15-25 range)`);
  if (raceRow.xp < 15 || raceRow.xp > 25) throw new Error(`FAIL: race-user xp ${raceRow.xp} outside single-award range - cooldown or update race broke`);

  console.log('\n--- Test 4: second flush with nothing dirty is a no-op ---');
  const noopWritesBefore = writes;
  const noopResult = await levelingService.flush(database);
  console.log(`  flushed: ${noopResult.flushed}, writes issued: ${writes - noopWritesBefore}`);
  if (noopResult.flushed !== 0 || writes - noopWritesBefore !== 0) throw new Error('FAIL: no-op flush should not touch the database');

  console.log('\n--- Test 5: existing XP is preserved and added to, not reset ---');
  await db.run(`INSERT INTO users (discord_id, username, xp, level) VALUES ('existing-user', 'Existing', 500, 2)`);
  await levelingService.handleMessage(fakeMessage('existing-user', 'Existing'), null, database);
  await levelingService.flush(database);
  const existingRow = await db.get(`SELECT xp FROM users WHERE discord_id = 'existing-user'`);
  console.log(`  existing-user xp after one message: ${existingRow.xp} (should be 515-525, i.e. 500 + new gain)`);
  if (existingRow.xp < 515 || existingRow.xp > 525) throw new Error('FAIL: pre-existing XP was not preserved/added to correctly');

  console.log('\n--- Test 6: flush retries and recovers from a transient SQLITE_BUSY ---');
  await levelingService.handleMessage(fakeMessage('busy-test-user', 'BusyUser'), null, database);
  let busyThrown = false;
  const originalExec = db.exec.bind(db);
  db.exec = (...args) => {
    if (args[0] === 'BEGIN IMMEDIATE' && !busyThrown) {
      busyThrown = true;
      const err = new Error('SQLITE_BUSY: database is locked');
      err.code = 'SQLITE_BUSY';
      return Promise.reject(err);
    }
    return originalExec(...args);
  };
  const busyResult = await levelingService.flush(database);
  db.exec = originalExec;
  console.log(`  flush result after one simulated SQLITE_BUSY: flushed=${busyResult.flushed}, error=${busyResult.error ? busyResult.error.message : 'none'}`);
  if (busyResult.flushed !== 1 || busyResult.error) throw new Error('FAIL: flush did not recover from a transient SQLITE_BUSY');
  const busyRow = await db.get(`SELECT xp FROM users WHERE discord_id = 'busy-test-user'`);
  if (!busyRow) throw new Error('FAIL: busy-test-user was not persisted after retry');
  console.log(`  busy-test-user persisted after retry: xp=${busyRow.xp}`);

  console.log('\n--- Metrics snapshot ---');
  console.log(levelingService.getMetrics());

  levelingService.stopAutoFlush();
  await db.close();
  console.log('\nAll leveling load-test assertions passed.');
}

main().catch((error) => {
  console.error('\nLOAD TEST FAILED:', error);
  process.exit(1);
});
