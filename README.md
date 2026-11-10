# SQLite per-statement latency: Archil `exec` vs. an open Turso connection

One script, `bench.mjs`. It runs the same single-row `INSERT` and point `SELECT`
50 times, one after another, against:

- an Archil disk through the documented SQLite path (`@archildata/sqlite` 0.0.23
  on `disk` 1.12.0), where every statement is one serverless `exec` that starts
  `node`, opens the file with `node:sqlite`, runs the statement and exits;
- a Turso database through `@libsql/client` 0.18.0 on one open connection.

It also times `disk.exec("true")`, which is the cost of an `exec` round trip with
no SQLite in it, and prints the server's own `queueMs` / `executeMs` for that call.

## Run

```sh
npm install
cp .env.example .env   # fill in ARCHIL_API_KEY and ARCHIL_REGION; Turso is optional
npm run bench
```

Node 22.19 or later. Without `ARCHIL_DISK_ID` the script creates a disk and
deletes it at the end. For the Turso half: `turso db create <name>`, then
`turso db show <name> --url` and `turso db tokens create <name>`. The script
creates and drops its own table there.

## Result

2026-11-09, client on a laptop outside AWS (so every number includes its
network path to Oregon), Archil disk in
`aws-us-west-2` (Archil-managed storage), Turso database in `aws-us-west-2`, N = 50:

| case | p50 ms | p95 ms | min ms | max ms |
| --- | ---: | ---: | ---: | ---: |
| archil `exec("true")` | 113 | 200 | 66 | 300 |
| archil sqlite write | 237 | 332 | 191 | 732 |
| archil sqlite read | 153 | 229 | 115 | 240 |
| turso write | 46 | 160 | 40 | 1311 |
| turso read | 27 | 110 | 25 | 1183 |

For `exec("true")` the server reported p50 `queueMs` 76 and `executeMs` 4. The
first `exec` on the new disk took 293 ms; the first Turso statement, which
includes opening the connection, took 424 ms.

## What it shows

The floor is the `exec` call itself: about 110 ms for a command that does
nothing, of which the server attributes about 76 ms to queueing, booting and
mounting and 4 ms to the command. A read adds about 40 ms on top of that floor
and a write about 125 ms. Turso holds the database open behind a connection, so
a statement costs one round trip.

The use case is a service that owns the queries and writes (so mounting the disk
on our own compute is not the answer) and wants many SQLite databases on Archil
at interactive latency. What would close the gap is something that keeps the
database open between statements: a session or connection over `exec`, or a
long-lived process next to the disk that accepts statements.
