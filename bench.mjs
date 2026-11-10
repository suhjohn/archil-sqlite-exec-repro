// Per-statement SQLite latency: Archil serverless exec vs. a Turso (libSQL) connection.
//
// The same single-row write and point read, N times, sequentially, from one client:
//   1. archil exec floor     disk.exec("true"): no SQLite at all, just one exec round trip
//   2. archil sqlite write   @archildata/sqlite  db.write`INSERT ...`.run()   (one exec per statement)
//   3. archil sqlite read    @archildata/sqlite  db.read`SELECT ...`.get()    (one exec per statement)
//   4. turso write / read    @libsql/client over one open connection          (skipped without TURSO_*)
//
// Client milliseconds are wall-clock around each call. For row 1 the server's own
// timing (queueMs: schedule + boot + mount, executeMs: the command) is printed too.

import * as archil from "disk";
import { createDatabase } from "@archildata/sqlite";
import { createClient } from "@libsql/client";

const N = Number(process.env.N ?? 50);
const env = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const quantile = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
const summarize = (samples) => {
  const sorted = [...samples].sort((a, b) => a - b);
  return { p50: quantile(sorted, 0.5), p95: quantile(sorted, 0.95), min: sorted[0], max: sorted.at(-1) };
};
const timed = async (fn) => {
  const start = performance.now();
  const result = await fn();
  return [performance.now() - start, result];
};
const run = async (count, fn) => {
  const samples = [];
  for (let i = 0; i < count; i++) samples.push((await timed(() => fn(i)))[0]);
  return samples;
};

const rows = [];
const record = (name, samples, note = "") => {
  const s = summarize(samples);
  rows.push({
    case: name,
    n: samples.length,
    "p50 ms": Math.round(s.p50),
    "p95 ms": Math.round(s.p95),
    "min ms": Math.round(s.min),
    "max ms": Math.round(s.max),
    note,
  });
};

const SCHEMA = "CREATE TABLE IF NOT EXISTS items (key TEXT PRIMARY KEY, value TEXT NOT NULL, version INTEGER NOT NULL)";
const value = (i) => JSON.stringify({ i, payload: "x".repeat(200) });

// ---------------------------------------------------------------- Archil
archil.configure({ apiKey: env("ARCHIL_API_KEY"), region: env("ARCHIL_REGION") });

let disk;
let createdDisk = false;
if (process.env.ARCHIL_DISK_ID) {
  disk = await archil.getDisk(process.env.ARCHIL_DISK_ID);
} else {
  ({ disk } = await archil.createDisk({ name: `sqlite-exec-repro-${Date.now()}` }));
  createdDisk = true;
}
console.log(`archil disk ${disk.id} (${process.env.ARCHIL_REGION})`);

try {
  const [coldMs] = await timed(() => disk.exec("true"));
  console.log(`archil first exec on this disk: ${Math.round(coldMs)} ms`);

  const queue = [];
  const execute = [];
  const floor = await run(N, async () => {
    const { timing } = await disk.exec("true");
    queue.push(timing.queueMs);
    execute.push(timing.executeMs);
  });
  record(
    'archil exec("true")',
    floor,
    `server-side p50: queue ${Math.round(summarize(queue).p50)} ms, execute ${Math.round(summarize(execute).p50)} ms`,
  );

  const path = `repro/${Date.now()}.sqlite`;
  const db = await createDatabase(disk, path);
  await db.write([SCHEMA]).run();

  record(
    "archil sqlite write",
    await run(N, (i) => db.write`INSERT INTO items (key, value, version) VALUES (${`k${i}`}, ${value(i)}, ${1})`.run()),
    "one exec per statement",
  );
  record(
    "archil sqlite read",
    await run(N, (i) => db.read`SELECT value, version FROM items WHERE key = ${`k${i}`}`.get()),
    "one exec per statement",
  );
  const count = await db.read`SELECT count(*) AS n FROM items`.get();
  if (Number(count.n) !== N) throw new Error(`archil: expected ${N} rows, found ${count.n}`);
} finally {
  if (createdDisk) await disk.delete();
}

// ---------------------------------------------------------------- Turso
if (process.env.TURSO_DATABASE_URL) {
  const turso = createClient({ url: env("TURSO_DATABASE_URL"), authToken: env("TURSO_AUTH_TOKEN") });
  try {
    const table = `items_${Date.now()}`;
    const [firstMs] = await timed(() => turso.execute(SCHEMA.replace("items", table)));
    console.log(`turso first statement on this connection: ${Math.round(firstMs)} ms`);
    record(
      "turso write",
      await run(N, (i) =>
        turso.execute({ sql: `INSERT INTO ${table} (key, value, version) VALUES (?, ?, ?)`, args: [`k${i}`, value(i), 1] }),
      ),
      "one open connection",
    );
    record(
      "turso read",
      await run(N, (i) => turso.execute({ sql: `SELECT value, version FROM ${table} WHERE key = ?`, args: [`k${i}`] })),
      "one open connection",
    );
    const count = await turso.execute(`SELECT count(*) AS n FROM ${table}`);
    if (Number(count.rows[0].n) !== N) throw new Error(`turso: expected ${N} rows, found ${count.rows[0].n}`);
    await turso.execute(`DROP TABLE ${table}`);
  } finally {
    turso.close();
  }
} else {
  console.log("TURSO_DATABASE_URL not set: skipping the Turso half");
}

console.table(rows);
