#!/usr/bin/env node
/* Tests for the one thing in reef-agent.mjs that cannot be checked by looking
 * at it: what happens to the state file when more than one process writes it.
 *
 * That is the normal arrangement here, not an edge case — a `listen` process
 * runs for days off a single load(), while every `send` and `read` is its own
 * short-lived process against the same file — and the failure it used to
 * produce (a save publishing a stale whole-file snapshot over somebody else's
 * change) is silent: nothing errors, the map is simply missing entries later.
 * So it gets a test that actually runs two processes at once.
 *
 * No network, no PIN, no server: everything here is load()/save() against a
 * scratch file under the OS temp dir. Nothing touches agent/.
 *
 *   node agent/test-state-file.mjs
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, utimesSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { ReefAgent } from './reef-agent.mjs';

const AGENT_URL = pathToFileURL(fileURLToPath(new URL('reef-agent.mjs', import.meta.url))).href;
const dir = mkdtempSync(join(tmpdir(), 'reef-state-test-'));
const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
const fresh = (name) => join(dir, name + '.json');

let failures = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

/* One child process per role, so the concurrency under test is real OS
 * concurrency rather than two objects in one event loop. */
const WORKER = join(dir, 'worker.mjs');
writeFileSync(WORKER, `
import { ReefAgent } from ${JSON.stringify(AGENT_URL)};

const [, , statePath, mode, tag] = process.argv;
const agent = new ReefAgent({ pin: 'test', statePath });
await agent.load();

if (mode === 'send') {
  // What send() does to the state file, minus the network.
  agent.state.sent = agent.state.sent || {};
  agent.state.sent[tag] = 'message ' + tag;
  await agent.save();
} else if (mode === 'stale-listener') {
  // What a long-lived listener does: loaded once, ages, and keeps saving from
  // whatever it holds in memory — the write that used to erase everyone else's.
  for (let i = 0; i < 25; i++) {
    agent.state.seq = (agent.state.seq || 0) + 1;
    await agent.save();
    await new Promise((r) => setTimeout(r, 20));
  }
} else if (mode === 'reader') {
  // A torn write is only visible from outside, mid-write.
  let ok = 0;
  const until = Date.now() + Number(tag);
  while (Date.now() < until) {
    try {
      const parsed = JSON.parse(await import('node:fs').then((fs) => fs.readFileSync(statePath, 'utf8')));
      if (!parsed.identity) throw new Error('parsed but incomplete');
      ok++;
    } catch (e) {
      // A rename replacing the file can briefly deny the open on Windows; that
      // is not a torn read, it is the atomicity working. Anything else is.
      if (!['EPERM', 'EACCES', 'EBUSY', 'ENOENT'].includes(e.code)) {
        process.stdout.write('TORN ' + e.message + '\\n');
        process.exit(1);
      }
    }
  }
  process.stdout.write('READS ' + ok + '\\n');
} else if (mode === 'cold-start') {
  process.stdout.write('KEY ' + agent.state.identity.publicJwk.x + '\\n');
}
`);

function run(statePath, mode, tag = '') {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WORKER, statePath, mode, tag], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

/* ---------------------------------------------------------------------- */

test('a stale in-memory save no longer erases another process\'s send', async () => {
  const statePath = fresh('lost-update');
  await new ReefAgent({ pin: 'test', statePath }).load();

  // The listener: loads now, and will not load again.
  const listener = await new ReefAgent({ pin: 'test', statePath }).load();

  // The CLI: a whole separate process life — load, add one send, exit.
  const cli = await new ReefAgent({ pin: 'test', statePath }).load();
  cli.state.sent = { 'msg-from-cli': 'hello' };
  await cli.save();
  assert.equal(read(statePath).sent['msg-from-cli'], 'hello');

  // The listener now saves for an unrelated reason, from its stale snapshot.
  listener.state.seq = 42;
  await listener.save();

  const disk = read(statePath);
  assert.equal(disk.sent['msg-from-cli'], 'hello', 'the CLI send survived the listener save');
  assert.equal(disk.seq, 42, 'and the listener still recorded what it came to record');

  // The same sequence against the old blind-overwrite save, to show the test
  // is not vacuous: this is what it looked like before.
  const control = fresh('lost-update-control');
  writeFileSync(control, JSON.stringify({ identity: disk.identity, seq: 0, sent: {} }));
  const staleSnapshot = JSON.parse(readFileSync(control, 'utf8'));
  const withSend = JSON.parse(readFileSync(control, 'utf8'));
  withSend.sent['msg-from-cli'] = 'hello';
  writeFileSync(control, JSON.stringify(withSend));
  staleSnapshot.seq = 42;
  writeFileSync(control, JSON.stringify(staleSnapshot)); // blind overwrite
  assert.equal(read(control).sent['msg-from-cli'], undefined,
               'control: the old save() does lose it, so the assertion above means something');
});

test('twelve concurrent sends survive a listener saving throughout', async () => {
  const statePath = fresh('multiprocess');
  await new ReefAgent({ pin: 'test', statePath }).load();

  // Started first and left to age, exactly like the real one.
  const listener = run(statePath, 'stale-listener');
  await new Promise((r) => setTimeout(r, 150));

  const tags = Array.from({ length: 12 }, (_, i) => `send-${i}`);
  const senders = await Promise.all(tags.map((tag) => run(statePath, 'send', tag)));
  for (const s of senders) assert.equal(s.code, 0, `sender exited ${s.code}: ${s.err}`);
  const listenerResult = await listener;
  assert.equal(listenerResult.code, 0, `listener exited ${listenerResult.code}: ${listenerResult.err}`);

  const disk = read(statePath);
  const missing = tags.filter((tag) => disk.sent[tag] === undefined);
  assert.deepEqual(missing, [], 'every concurrent send is still on disk');
  assert.ok(disk.seq > 0, 'and the listener\'s own field was written too');
});

test('a reader never sees a half-written file', async () => {
  const statePath = fresh('torn');
  const writer = await new ReefAgent({ pin: 'test', statePath }).load();

  const reader = run(statePath, 'reader', '1500');
  const until = Date.now() + 1500;
  let writes = 0;
  while (Date.now() < until) {
    writer.state.sent[`torn-${writes++}`] = 'x'.repeat(400);
    await writer.save();
  }
  const result = await reader;
  assert.equal(result.code, 0, `reader saw a torn file: ${result.out}${result.err}`);
  assert.match(result.out, /^READS (\d+)/, 'the reader actually read something');
  assert.ok(Number(result.out.match(/^READS (\d+)/)[1]) > 0);
  assert.ok(writes > 10, `writer got ${writes} saves in`);
});

test('two cold starts on one missing file agree on one identity', async () => {
  const statePath = fresh('cold-start');
  const [a, b] = await Promise.all([run(statePath, 'cold-start'), run(statePath, 'cold-start')]);
  assert.equal(a.code, 0, a.err);
  assert.equal(b.code, 0, b.err);
  assert.equal(a.out, b.out, 'the loser adopted the winner\'s key rather than minting a second one');
  assert.equal(read(statePath).identity.publicJwk.x, a.out.trim().slice('KEY '.length));
});

test('an existing identity is never overwritten', async () => {
  const statePath = fresh('identity');
  const first = await new ReefAgent({ pin: 'test', statePath }).load();
  const key = first.state.identity.publicJwk.x;

  const other = await new ReefAgent({ pin: 'test', statePath }).load();
  other.state.identity = { privateJwk: { fake: true }, publicJwk: { x: 'somebody-elses' } };
  other.state.seq = 7;
  await other.save();

  assert.equal(read(statePath).identity.publicJwk.x, key);
  assert.equal(read(statePath).seq, 7, 'the rest of that save still landed');
});

test('a lock left behind by a process that died inside save() does not wedge it', async () => {
  const statePath = fresh('stale-lock');
  const agent = await new ReefAgent({ pin: 'test', statePath }).load();
  const lockPath = statePath + '.save.lock';

  writeFileSync(lockPath, '999999 0');
  const longAgo = new Date(Date.now() - 60_000);
  utimesSync(lockPath, longAgo, longAgo);

  agent.state.sent['after-a-stale-lock'] = 'ok';
  const started = Date.now();
  await agent.save();

  assert.equal(read(statePath).sent['after-a-stale-lock'], 'ok');
  assert.ok(Date.now() - started < 2000, 'stolen rather than waited out');
  assert.equal(existsSync(lockPath), false, 'and cleaned up on the way out');
});

test('a corrupt state file is fatal, not silently re-identified', async () => {
  const statePath = fresh('corrupt');
  writeFileSync(statePath, '{"identity": {"privateJwk"');
  const before = readFileSync(statePath, 'utf8');
  await assert.rejects(() => new ReefAgent({ pin: 'test', statePath }).load(), /does not parse/);
  assert.equal(readFileSync(statePath, 'utf8'), before, 'and the file was left exactly as it was');

  const empty = fresh('empty');
  writeFileSync(empty, '');
  await assert.rejects(() => new ReefAgent({ pin: 'test', statePath: empty }).load(), /does not parse/);
});

test('session is only written by a process that has just unlocked', async () => {
  const statePath = fresh('session');
  const first = await new ReefAgent({ pin: 'test', statePath }).load();
  first.state.session = { pin: 'test', token: 'old', roomId: 'r', deviceId: 'd' };
  first._sessionIsMine = true;                       // as _unlockFresh() sets it
  await first.save();

  const stale = await new ReefAgent({ pin: 'test', statePath }).load();  // holds 'old'
  const unlocker = await new ReefAgent({ pin: 'test', statePath }).load();
  unlocker.state.session = { pin: 'test', token: 'new', roomId: 'r', deviceId: 'd' };
  unlocker._sessionIsMine = true;
  await unlocker.save();
  assert.equal(read(statePath).session.token, 'new');

  stale.state.seq = 5;
  await stale.save();
  assert.equal(read(statePath).session.token, 'new',
               'a save from a process that never unlocked left the fresh token alone');
  assert.equal(read(statePath).seq, 5);
});

test('seq keeps the high-water mark, and the file shape scripts read is intact', async () => {
  const statePath = fresh('seq');
  const a = await new ReefAgent({ pin: 'test', statePath }).load();
  const b = await new ReefAgent({ pin: 'test', statePath }).load();

  a.state.seq = 900;
  a.state.session = { pin: 'test', token: 't', roomId: 'room-abc', deviceId: 'd' };
  a._sessionIsMine = true;
  await a.save();

  b.state.seq = 12;                                  // an older cursor
  await b.save();
  assert.equal(read(statePath).seq, 900, 'a lower cursor never drags the file backwards');
  assert.equal(b.state.seq, 12, 'and this process keeps its own, so it re-reads rather than skips');

  // reef-up.sh greps the file for "session" and reads .session.roomId out of it.
  const raw = readFileSync(statePath, 'utf8');
  assert.match(raw, /"session"/);
  assert.equal(JSON.parse(raw).session.roomId, 'room-abc');
});

test('the 500-entry cap applies to the merged map, not to one writer\'s copy', async () => {
  const statePath = fresh('cap');
  const a = await new ReefAgent({ pin: 'test', statePath }).load();
  for (let i = 0; i < 480; i++) a.state.sent[`old-${i}`] = 'x';
  await a.save();

  const b = await new ReefAgent({ pin: 'test', statePath }).load();
  for (let i = 0; i < 40; i++) b.state.sent[`new-${i}`] = 'y';
  await b.save();

  const sent = read(statePath).sent;
  const ids = Object.keys(sent);
  assert.equal(ids.length, 500, 'trimmed to the cap');
  assert.equal(sent['old-0'], undefined, 'oldest first out');
  assert.equal(sent['old-479'], 'x', 'recent history kept');
  assert.equal(sent['new-39'], 'y', 'and every new entry kept');
});

/* ---------------------------------------------------------------------- */

for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`ok    ${name}`);
  } catch (e) {
    failures++;
    console.log(`FAIL  ${name}\n      ${(e && e.message) || e}`);
  }
}

try {
  rmSync(dir, { recursive: true, force: true });
} catch (e) {
  /* scratch dir, and Windows sometimes still has a handle on it */
}

console.log(`\n${tests.length - failures}/${tests.length} passed`);
process.exit(failures ? 1 : 0);
