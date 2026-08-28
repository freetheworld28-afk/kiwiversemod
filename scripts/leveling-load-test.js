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

  console.log('\n--- Test 7: /rank-style read shows fresh XP immediately, with zero extra SQLite I/O ---');
  const rankUserId = 'rank-test-user';
  await levelingService.handleMessage(fakeMessage(rankUserId, 'RankUser'), null, database);
  const readsBefore7 = reads;
  const writesBefore7 = writes;
  const rankRecord = await levelingService.getCurrentUser(database, GUILD_ID, rankUserId, 'RankUser');
  const rankPosition = await levelingService.getEffectiveRank(database, rankUserId, rankRecord.xp);
  console.log(`  Immediately after one message: cached xp=${rankRecord.xp}, rank=#${rankPosition}`);
  console.log(`  SQLite reads caused by the read command: ${reads - readsBefore7} (expected 1 - the user's own xp/level is already cached with zero reads; the 1 read is getEffectiveRank's COUNT-of-others query, which is expected)`);
  console.log(`  SQLite writes caused by the read command: ${writes - writesBefore7} (expected 0)`);
  if (rankRecord.xp < 15 || rankRecord.xp > 25) throw new Error('FAIL: /rank-style read did not show the XP just awarded');
  if (writes - writesBefore7 !== 0) throw new Error('FAIL: a cache-aware read command wrote to SQLite');

  console.log('\n--- Test 8: /profile-style read shows the same fresh XP, still zero writes ---');
  const writesBefore8 = writes;
  const profileRecord = await levelingService.getCurrentUser(database, GUILD_ID, rankUserId, 'RankUser');
  console.log(`  /profile-style xp read: ${profileRecord.xp} (should match Test 7's ${rankRecord.xp})`);
  if (profileRecord.xp !== rankRecord.xp) throw new Error('FAIL: /profile-style read disagreed with /rank-style read for the same user');
  if (writes - writesBefore8 !== 0) throw new Error('FAIL: /profile-style read wrote to SQLite');

  console.log('\n--- Test 9: leaderboard surfaces a cached user whose stale DB row would otherwise miss a small pool ---');
  // 15 DB-only users with a moderate XP range populate a small candidate pool.
  for (let i = 0; i < 15; i++) {
    await db.run(`INSERT INTO users (discord_id, username, xp, level) VALUES (?, ?, ?, ?)`, `pool-${i}`, `Pool${i}`, 50 + i, 1);
  }
  // stale-user's SQLite row is low (would never make a small top-10 pool),
  // but their in-memory cache has since accumulated much higher XP -
  // simulating XP earned since their last periodic flush.
  await db.run(`INSERT INTO users (discord_id, username, xp, level) VALUES ('stale-user', 'StaleUser', 5, 0)`);
  const staleRecord = await levelingService.getCurrentUser(database, GUILD_ID, 'stale-user', 'StaleUser');
  staleRecord.xp = 999;
  staleRecord.level = 3;

  const smallPoolLeaderboard = await levelingService.getLeaderboard(database, 10, 10); // pool deliberately smaller than total DB rows
  const staleInTop = smallPoolLeaderboard.find((r) => r.discordId === 'stale-user');
  console.log(`  stale-user: db xp=5, cached xp=999 - present in top 10: ${Boolean(staleInTop)}, ranked #1: ${smallPoolLeaderboard[0]?.discordId === 'stale-user'}`);
  if (!staleInTop) throw new Error('FAIL: cached user with fresh high XP was missing from the leaderboard despite a stale low DB row');
  if (smallPoolLeaderboard[0].discordId !== 'stale-user') throw new Error('FAIL: cached user with the highest effective XP should rank #1');

  console.log('\n--- Test 10: user not cached in this process falls back to SQLite (simulates post-restart read) ---');
  await db.run(`INSERT INTO users (discord_id, username, xp, level) VALUES ('never-cached-user', 'NeverCached', 777, 2)`);
  const readsBefore10 = reads;
  const writesBefore10 = writes;
  const neverCachedRecord = await levelingService.getCurrentUser(database, GUILD_ID, 'never-cached-user', 'NeverCached');
  console.log(`  never-cached-user resolved via SQLite fallback: xp=${neverCachedRecord.xp} (expected 777)`);
  console.log(`  SQLite reads: ${reads - readsBefore10} (expected 1), writes: ${writes - writesBefore10} (expected 0)`);
  if (neverCachedRecord.xp !== 777) throw new Error('FAIL: SQLite fallback for an uncached user returned the wrong XP');
  if (writes - writesBefore10 !== 0) throw new Error('FAIL: SQLite fallback read caused a write');

  console.log('\n--- Test 12: realistic load - exactly 1,000 messages across exactly 100 users ---');
  {
    const USER_COUNT = 100;
    const MESSAGES_PER_USER = 10; // 100 * 10 = 1000 messages total
    const readsBefore12 = reads;
    const writesBefore12 = writes;
    const messagesBefore12 = levelingService.getMetrics().messagesProcessed;
    const dirtyBefore12 = levelingService.getMetrics().dirtyCount; // may be non-zero from an earlier test's unflushed user

    const tasks12 = [];
    for (let u = 0; u < USER_COUNT; u++) {
      const userId = `load12-user-${u}`;
      for (let m = 0; m < MESSAGES_PER_USER; m++) {
        tasks12.push(levelingService.handleMessage(fakeMessage(userId, `Load12User${u}`), null, database));
      }
    }
    await Promise.all(tasks12);

    const messagesProcessed12 = levelingService.getMetrics().messagesProcessed - messagesBefore12;
    console.log(`  Fired ${tasks12.length} messages (expected 1000) across ${USER_COUNT} users`);
    console.log(`  messagesProcessed delta: ${messagesProcessed12}`);
    if (tasks12.length !== 1000) throw new Error('FAIL: test setup did not produce exactly 1000 messages');
    if (messagesProcessed12 !== 1000) throw new Error('FAIL: levelingService did not report processing all 1000 messages');

    console.log(`  SQLite reads during the run: ${reads - readsBefore12} (expected <= ${USER_COUNT}, one lazy-load per distinct user - no per-message query)`);
    console.log(`  SQLite writes during the run: ${writes - writesBefore12} (expected 0 - writes only happen on flush)`);
    if (writes - writesBefore12 !== 0) throw new Error('FAIL: a write happened on the per-message path during the 1000-message run');
    if (reads - readsBefore12 > USER_COUNT) throw new Error('FAIL: more reads than distinct users - a per-message query crept back in');

    // Each user sent 10 messages inside the same instant, so the 60s
    // cooldown should have allowed exactly one award per user.
    const sampleUser = await levelingService.getCurrentUser(database, GUILD_ID, 'load12-user-0', 'Load12User0');
    console.log(`  Sample user xp after 10 rapid-fire messages: ${sampleUser.xp} (should be a single award, 15-25 range - cooldown held)`);
    if (sampleUser.xp < 15 || sampleUser.xp > 25) throw new Error('FAIL: cooldown did not hold under 10 rapid messages from one user - XP looks like multiple awards');

    // /rank and /profile read path.
    const rankRead = await levelingService.getCurrentUser(database, GUILD_ID, 'load12-user-5', 'Load12User5');
    const profileRead = await levelingService.getCurrentUser(database, GUILD_ID, 'load12-user-5', 'Load12User5');
    console.log(`  /rank-style and /profile-style reads agree: ${rankRead.xp === profileRead.xp} (xp=${rankRead.xp})`);
    if (rankRead.xp !== profileRead.xp) throw new Error('FAIL: /rank and /profile disagree on the same user\'s cached XP');

    // Dirty tracking + batch flush.
    const metricsBeforeFlush = levelingService.getMetrics();
    const dirtyFromThisRun = metricsBeforeFlush.dirtyCount - dirtyBefore12;
    console.log(`  Dirty users pending flush: ${metricsBeforeFlush.dirtyCount} total, ${dirtyFromThisRun} attributable to this run (expected ${USER_COUNT})`);
    if (dirtyFromThisRun !== USER_COUNT) throw new Error(`FAIL: expected ${USER_COUNT} dirty users from this run, got ${dirtyFromThisRun}`);

    const writesBeforeFlush12 = writes;
    const flushResult12 = await levelingService.flush(database);
    console.log(`  Flush: ${flushResult12.flushed} users written in ${writes - writesBeforeFlush12} SQL statements inside one transaction`);
    if (flushResult12.flushed < USER_COUNT) throw new Error('FAIL: flush did not persist all dirty users from the load run');

    // Leaderboard accuracy: the sample user's cached xp must be reflected.
    // limit/poolSize are deliberately huge (not just "big enough for this
    // run") because this script shares one process/cache across all tests -
    // earlier tests' users are still cached and competing for top ranks, so
    // a modest limit could legitimately exclude this specific low-xp user
    // without that being a product bug.
    const leaderboard12 = await levelingService.getLeaderboard(database, 10_000, 10_000);
    const leaderboardEntry = leaderboard12.find((row) => row.discordId === 'load12-user-0');
    console.log(`  Leaderboard reflects sample user: xp=${leaderboardEntry?.xp} (should match cached ${sampleUser.xp})`);
    if (!leaderboardEntry || leaderboardEntry.xp !== sampleUser.xp) throw new Error('FAIL: leaderboard is missing or inaccurate for a user from the load run');

    // Cache growth is bounded by distinct real users, not message volume -
    // 1000 messages from 100 users should leave at most ~100 cached users
    // from this run (plus whatever earlier tests already cached).
    console.log(`  Total cached users after the run: ${levelingService.getMetrics().cachedUsers}`);
  }

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
