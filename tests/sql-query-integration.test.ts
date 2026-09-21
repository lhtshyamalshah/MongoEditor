import assert from "node:assert/strict";
import test from "node:test";
import { Pool } from "pg";
import { connect, disconnect, query, sessionFor } from "../lib/postgres";

const uri = process.env.TEST_POSTGRES_URI;
test(
  "SQL console integration: safe execution, limits, precision and cleanup",
  { skip: !uri },
  async (t) => {
    const url = new URL(uri!);
    assert.ok(
      ["localhost", "127.0.0.1"].includes(url.hostname) &&
        url.pathname === "/browser_test",
    );
    const { token } = await connect({ uri });
    const session = sessionFor(token);
    const base = { database: "browser_test", parameters: [], rowLimit: 25 };
    const pool = new Pool({ connectionString: uri });
    const schema = `query_test_${Date.now()}`;
    try {
      await pool.query(`CREATE SCHEMA "${schema}"`);
      await pool.query(
        `CREATE TABLE "${schema}".items (id int primary key, value text)`,
      );
      await pool.query(`INSERT INTO "${schema}".items VALUES (1,'original')`);
      await pool.query(
        `CREATE FUNCTION "${schema}".attempt_write() RETURNS text LANGUAGE plpgsql AS $$ BEGIN UPDATE "${schema}".items SET value='changed'; RETURN 'changed'; END $$`,
      );
      await t.test(
        "binds hostile strings as data and preserves duplicate column names and precision",
        async () => {
          const value = "'; DELETE FROM items; --";
          const result = await query(session, {
            ...base,
            sql: "SELECT $1::text AS duplicate, 9007199254740993::bigint AS duplicate, 1.12345678901234567890::numeric AS decimal, $2::text AS empty",
            parameters: [value, null],
          });
          assert.deepEqual(
            result.columns.map((column) => column.name),
            ["duplicate", "duplicate", "decimal", "empty"],
          );
          assert.deepEqual(result.rows, [
            [value, "9007199254740993", "1.12345678901234567890", null],
          ]);
          assert.equal(result.truncated, false);
        },
      );
      await t.test(
        "caps an unbounded query and accepts read-only CTEs",
        async () => {
          const result = await query(session, {
            ...base,
            sql: "WITH x AS (SELECT generate_series(1,1000) AS id) SELECT * FROM x;",
          });
          assert.equal(result.rows.length, 25);
          assert.equal(result.truncated, true);
          assert.equal(result.rows[24][0], "25");
          const empty = await query(session, {
            ...base,
            sql: "SELECT 1 WHERE false",
          });
          assert.equal(empty.rows.length, 0);
          assert.equal(empty.columns.length, 1);
        },
      );
      await t.test(
        "rejects writes, stacked commands and writes hidden inside a function",
        async () => {
          for (const sql of [
            `DELETE FROM "${schema}".items`,
            `SELECT 1; UPDATE "${schema}".items SET value='changed'`,
            `WITH x AS (DELETE FROM "${schema}".items RETURNING *) SELECT * FROM x`,
          ])
            await assert.rejects(query(session, { ...base, sql }));
          await assert.rejects(
            query(session, {
              ...base,
              sql: `SELECT "${schema}".attempt_write()`,
            }),
            /read-only/,
          );
          const unchanged = await pool.query(
            `SELECT value FROM "${schema}".items`,
          );
          assert.equal(unchanged.rows[0].value, "original");
        },
      );
      await t.test(
        "caps serialized results and leaves the session usable after SQL errors",
        async () => {
          const large = await query(session, {
            ...base,
            sql: "SELECT repeat('a',2100000)",
          });
          assert.equal(large.rows.length, 0);
          assert.equal(large.truncated, true);
          assert.match(large.notice, /2 MB/);
          await assert.rejects(
            query(session, { ...base, sql: "SELECT unknown_column" }),
            /column was not found/,
          );
          const next = await query(session, { ...base, sql: "SELECT 1" });
          assert.deepEqual(next.rows, [["1"]]);
        },
      );
      await t.test(
        "enforces read-only execution and disables parallel query workers",
        async () => {
          const settings = await query(session, {
            ...base,
            sql: "SELECT current_setting('transaction_read_only'), current_setting('statement_timeout'), current_setting('max_parallel_workers_per_gather')",
          });
          assert.deepEqual(settings.rows, [["on", "5s", "0"]]);
        },
      );
      await t.test(
        "rejects overlapping console queries and times out slow SQL",
        async () => {
          const slow = query(session, { ...base, sql: "SELECT pg_sleep(10)" });
          await assert.rejects(
            query(session, { ...base, sql: "SELECT 1" }),
            /already running/,
          );
          await assert.rejects(
            slow,
            (error: { code?: string }) => error.code === "57014",
          );
          assert.deepEqual(
            (await query(session, { ...base, sql: "SELECT 2" })).rows,
            [["2"]],
          );
        },
      );
      await t.test(
        "releases session advisory locks acquired from SELECT",
        async () => {
          await query(session, {
            ...base,
            sql: "SELECT pg_advisory_lock(829471234)",
          });
          const client = await pool.connect();
          try {
            const lock = await client.query(
              "SELECT pg_try_advisory_lock(829471234) AS acquired",
            );
            assert.equal(lock.rows[0].acquired, true);
            await client.query("SELECT pg_advisory_unlock(829471234)");
          } finally {
            client.release();
          }
        },
      );
      await t.test(
        "HTTP query action binds parameters, caps results, and rejects writes",
        { skip: !process.env.TEST_HTTP_BASE },
        async () => {
          const baseUrl = new URL(process.env.TEST_HTTP_BASE!);
          assert.ok(["localhost", "127.0.0.1"].includes(baseUrl.hostname));
          let apiToken = "";
          async function post(
            action: string,
            data: Record<string, unknown> = {},
          ) {
            const response = await fetch(new URL("/api/mongo", baseUrl), {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "X-Mongo-Browser": "1",
                "X-Connection-Token": apiToken,
              },
              body: JSON.stringify({ action, ...data }),
            });
            return { status: response.status, data: await response.json() };
          }
          try {
            const connected = await post("connect", { uri });
            assert.equal(connected.status, 200);
            apiToken = connected.data.token;
            const result = await post("query", {
              ...base,
              sql: "SELECT $1::text AS value, generate_series(1,200) AS n",
              parameters: ["bound value"],
            });
            assert.equal(result.status, 200);
            assert.equal(result.data.rows.length, 25);
            assert.deepEqual(result.data.rows[0], ["bound value", "1"]);
            assert.equal(result.data.truncated, true);
            assert.equal(
              (
                await post("query", {
                  ...base,
                  sql: `DELETE FROM "${schema}".items`,
                })
              ).status,
              400,
            );
            assert.equal(
              (
                await post("query", {
                  ...base,
                  sql: `SELECT "${schema}".attempt_write()`,
                })
              ).status,
              403,
            );
          } finally {
            if (apiToken) await post("disconnect");
          }
        },
      );
    } finally {
      await disconnect(token);
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await pool.end();
    }
  },
);
