import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import * as db from "../lib/database";
import * as pg from "../lib/postgres";
import { quoteIdentifier as qi } from "../lib/postgres-filter";

const uri = process.env.TEST_POSTGRES_URI;
test(
  "PostgreSQL integration: browsing, filters, lossless edits, conflicts and read-only tables",
  { skip: !uri },
  async (t) => {
    const url = new URL(uri!);
    assert.ok(
      ["localhost", "127.0.0.1"].includes(url.hostname) &&
        url.pathname === "/browser_test",
      "Use a disposable local database named browser_test.",
    );
    const pool = new Pool({ connectionString: uri });
    const namespace = `browser_test_${randomBytes(6).toString("hex")}`;
    const tableName = 'items.with"quotes';
    const table = `${qi(namespace)}.${qi(tableName)}`;
    let token = "";
    try {
      await pool.query(`CREATE SCHEMA ${qi(namespace)}`);
      await pool.query(`CREATE TABLE ${table} (
      tenant text, id bigint, name text, amount numeric(30,9), payload jsonb,
      tags text[], created timestamp, optional text, doubled bigint GENERATED ALWAYS AS (id * 2) STORED,
      PRIMARY KEY (tenant, id) INCLUDE (name))`);
      for (let id = 1; id <= 12; id++)
        await pool.query(
          `INSERT INTO ${table} (tenant,id,name,amount,payload,tags,created) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [
            "a",
            id,
            id === 1 ? "literal 50%_\\" : `row ${id}`,
            "12345678901234567890.123456789",
            '{"large":9007199254740993}',
            ["one", "two"],
            "2026-09-18 12:34:56.123456",
          ],
        );
      await pool.query(
        `INSERT INTO ${table} (tenant,id,name) VALUES ('b',1,'other tenant')`,
      );
      await pool.query(
        `CREATE VIEW ${qi(namespace)}.item_view AS SELECT * FROM ${table}`,
      );
      await pool.query(`CREATE TABLE ${qi(namespace)}.no_key (name text)`);
      const connected = await db.connect({ uri, database: "browser_test" });
      token = connected.token;
      assert.equal(connected.backend, "postgresql");
      assert.deepEqual(connected.databases, ["browser_test"]);
      assert.ok(!JSON.stringify(connected).includes("local-test-only"));
      const session = pg.sessionFor(token);
      const input = {
        database: "browser_test",
        collection: JSON.stringify([namespace, tableName]),
        page: 1,
        pageSize: 10,
      };
      await t.test(
        "discovers schemas and declared columns, including empty tables",
        async () => {
          const listed = await pg.collections(session, input);
          assert.ok(
            listed.collections.some(
              (item) => item.name === input.collection && !item.readOnly,
            ),
          );
          const listedTable = listed.collections.find(
            (item) => item.name === input.collection,
          )!;
          assert.equal(listedTable.schema, namespace);
          assert.equal(listedTable.table, tableName);
          assert.equal(typeof listedTable.owner, "string");
          assert.ok(listedTable.owner.length > 0);
          assert.ok(
            listed.collections.some(
              (item) =>
                item.name === JSON.stringify([namespace, "item_view"]) &&
                item.readOnly,
            ),
          );
          const schema = await pg.schema(session, input);
          assert.deepEqual(
            schema.columns.filter((c) => c.primaryKey).map((c) => c.name),
            ["tenant", "id"],
          );
          assert.ok(
            schema.columns.find((c) => c.name === "doubled")?.generated,
          );
          const empty = await pg.schema(session, {
            ...input,
            collection: JSON.stringify([namespace, "no_key"]),
          });
          assert.equal(empty.columns.length, 1);
          assert.equal(empty.readOnly, true);
          assert.ok(
            (await pg.databases(session)).databases.includes("browser_test"),
          );
        },
      );
      await t.test(
        "paginates in numeric primary-key order and preserves precise values",
        async () => {
          const first = await pg.documents(session, input);
          assert.equal(first.total, null);
          assert.equal(first.hasNext, true);
          assert.deepEqual(
            first.documents.map((row) => row.value.id),
            Array.from({ length: 10 }, (_, i) => String(i + 1)),
          );
          assert.equal(
            first.documents[0].value.amount,
            "12345678901234567890.123456789",
          );
          assert.equal(
            first.documents[0].value.created,
            "2026-09-18 12:34:56.123456",
          );
          assert.ok(
            first.documents[0].value.payload?.includes("9007199254740993"),
          );
          const second = await pg.documents(session, {
            ...input,
            page: 2,
            after: first.nextCursor,
          });
          assert.equal(second.documents.length, 3);
          assert.equal(second.hasNext, false);
          assert.deepEqual(
            second.documents.map((row) => [row.value.tenant, row.value.id]),
            [
              ["a", "11"],
              ["a", "12"],
              ["b", "1"],
            ],
          );
          await assert.rejects(
            pg.documents(session, { ...input, page: 2 }),
            /next-page cursor/,
          );
          await assert.rejects(
            pg.documents(session, { ...input, page: 2, after: { id: "10" } }),
            /Invalid page cursor/,
          );
        },
      );
      await t.test(
        "searches literals, nulls, typed comparisons, and rejects injection",
        async () => {
          const literal = await pg.documents(session, {
            ...input,
            query: "50%_\\",
            field: "name",
          });
          assert.equal(literal.documents.length, 1);
          await assert.rejects(
            pg.documents(session, { ...input, query: "50%_\\" }),
            /Choose a search column/,
          );
          const filtered = await pg.documents(session, {
            ...input,
            mode: "json",
            query: JSON.stringify({
              id: { $gte: "10" },
              tenant: "a",
              optional: null,
            }),
          });
          assert.equal(filtered.documents.length, 3);
          const injection = await pg.documents(session, {
            ...input,
            mode: "json",
            query: JSON.stringify({ name: "'; DROP TABLE items; --" }),
          });
          assert.equal(injection.documents.length, 0);
          await assert.rejects(
            pg.documents(session, {
              ...input,
              mode: "json",
              query: '{"$where":"1=1"}',
            }),
            /Unknown column/,
          );
        },
      );
      await t.test(
        "keyset order follows the index and survives deletion of the cursor row",
        async () => {
          const name = "reverse_key";
          await pool.query(
            `CREATE TABLE ${qi(namespace)}.${qi(name)} (id integer, tenant text, PRIMARY KEY (tenant, id))`,
          );
          await pool.query(
            `INSERT INTO ${qi(namespace)}.${qi(name)} SELECT n, 'a' FROM generate_series(1,25) n`,
          );
          const base = {
            ...input,
            collection: JSON.stringify([namespace, name]),
          };
          const first = await pg.documents(session, base);
          assert.deepEqual(Object.keys(first.nextCursor!), ["tenant", "id"]);
          await pool.query(
            `DELETE FROM ${qi(namespace)}.${qi(name)} WHERE id=10`,
          );
          const second = await pg.documents(session, {
            ...base,
            page: 2,
            after: first.nextCursor,
          });
          assert.deepEqual(
            second.documents.map((row) => row.value.id),
            Array.from({ length: 10 }, (_, i) => String(i + 11)),
          );
          const last = await pg.documents(session, {
            ...base,
            page: 3,
            after: second.nextCursor,
          });
          assert.equal(last.documents.length, 5);
          assert.equal(last.hasNext, false);
          const filtered = await pg.documents(session, {
            ...base,
            mode: "json",
            query: '{"id":{"$gte":"12"}}',
          });
          const filteredNext = await pg.documents(session, {
            ...base,
            mode: "json",
            query: '{"id":{"$gte":"12"}}',
            page: 2,
            after: filtered.nextCursor,
          });
          assert.deepEqual(
            filteredNext.documents.map((row) => row.value.id),
            ["22", "23", "24", "25"],
          );
        },
      );
      await t.test(
        "keyless tables and views return limited previews without misleading Next",
        async () => {
          await pool.query(
            `INSERT INTO ${qi(namespace)}.no_key SELECT 'row ' || n FROM generate_series(1,200) n`,
          );
          for (const collection of ["no_key", "item_view"]) {
            const base = {
              ...input,
              collection: JSON.stringify([namespace, collection]),
            };
            const result = await pg.documents(session, base);
            assert.equal(result.documents.length, 10);
            assert.equal(result.total, null);
            assert.equal(result.hasNext, false);
            assert.equal(result.nextCursor, null);
            assert.equal(result.pagination, "preview");
            assert.match(result.notice, /Limited preview/);
            await assert.rejects(
              pg.documents(session, { ...base, page: 2 }),
              /limited preview/,
            );
          }
        },
      );
      await t.test(
        "updates only the composite key and preserves unmodified precise values",
        async () => {
          const row = (await pg.documents(session, input)).documents[0];
          await pg.mutate(
            session,
            {
              ...input,
              id: JSON.stringify(row.id),
              revision: row.revision,
              document: JSON.stringify({ ...row.value, name: "edited" }),
            },
            "update",
          );
          const found = await pool.query(
            `SELECT tenant, name, amount::text, created::text FROM ${table} WHERE id=1 ORDER BY tenant`,
          );
          assert.equal(found.rows[0].name, "edited");
          assert.equal(found.rows[1].name, "other tenant");
          assert.equal(found.rows[0].amount, row.value.amount);
          assert.equal(found.rows[0].created, row.value.created);
          await assert.rejects(
            pg.mutate(
              session,
              { ...input, id: JSON.stringify(row.id), revision: row.revision },
              "delete",
            ),
            /changed/,
          );
        },
      );
      await t.test(
        "rejects changed keys, generated columns, missing columns and unsafe numeric input",
        async () => {
          const row = (await pg.documents(session, input)).documents[0];
          const base = {
            ...input,
            id: JSON.stringify(row.id),
            revision: row.revision,
          };
          for (const change of [{ id: "44" }, { doubled: "44" }])
            await assert.rejects(
              pg.mutate(
                session,
                {
                  ...base,
                  document: JSON.stringify({ ...row.value, ...change }),
                },
                "update",
              ),
              /cannot be changed/,
            );
          await assert.rejects(
            pg.mutate(
              session,
              { ...base, document: JSON.stringify({ tenant: "a", id: "1" }) },
              "update",
            ),
            /every column/,
          );
          await assert.rejects(
            pg.mutate(
              session,
              {
                ...base,
                document: JSON.stringify({ ...row.value, amount: 123 }),
              },
              "update",
            ),
            /Use strings/,
          );
          await assert.rejects(
            pg.mutate(session, { ...base, id: '{"id":"1"}' }, "delete"),
            /complete primary key/,
          );
          await assert.rejects(
            pg.mutate(
              session,
              { ...base, id: '{"id":{"$ne":null},"tenant":"a"}' },
              "delete",
            ),
            /complete primary key/,
          );
        },
      );
      await t.test(
        "serializes competing updates and reports one conflict",
        async () => {
          const row = (await pg.documents(session, input)).documents[0];
          const results = await Promise.allSettled(
            ["first", "second"].map((name) =>
              pg.mutate(
                session,
                {
                  ...input,
                  id: JSON.stringify(row.id),
                  revision: row.revision,
                  document: JSON.stringify({ ...row.value, name }),
                },
                "update",
              ),
            ),
          );
          assert.equal(
            results.filter((result) => result.status === "fulfilled").length,
            1,
          );
          const rejected = results.find(
            (result) => result.status === "rejected",
          ) as PromiseRejectedResult;
          assert.equal(rejected.reason.status, 409);
        },
      );
      await t.test(
        "blocks view and keyless mutations, deletes exactly one row",
        async () => {
          for (const relation of ["item_view", "no_key"])
            await assert.rejects(
              pg.mutate(
                session,
                { ...input, collection: JSON.stringify([namespace, relation]) },
                "delete",
              ),
              /read-only/,
            );
          const row = (await pg.documents(session, input)).documents[0];
          await pg.mutate(
            session,
            { ...input, id: JSON.stringify(row.id), revision: row.revision },
            "delete",
          );
          const remaining = await pool.query(
            `SELECT tenant FROM ${table} WHERE id=1`,
          );
          assert.deepEqual(remaining.rows, [{ tenant: "b" }]);
          await assert.rejects(
            pg.mutate(
              session,
              { ...input, id: JSON.stringify(row.id), revision: row.revision },
              "delete",
            ),
            /no longer exists/,
          );
        },
      );
      await t.test(
        "running HTTP API dispatches PostgreSQL operations and protects mutations",
        { skip: !process.env.TEST_HTTP_BASE },
        async () => {
          const base = new URL(process.env.TEST_HTTP_BASE!);
          assert.ok(["localhost", "127.0.0.1"].includes(base.hostname));
          let apiToken = "";
          async function post(
            action: string,
            data: Record<string, unknown> = {},
          ) {
            const response = await fetch(new URL("/api/mongo", base), {
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
            const connection = await post("connect", { uri });
            assert.equal(connection.status, 200);
            assert.equal(connection.data.backend, "postgresql");
            apiToken = connection.data.token;
            assert.equal((await post("collections", input)).status, 200);
            assert.equal((await post("schema", input)).status, 200);
            assert.equal((await post("databases")).status, 200);
            const rows = await post("documents", {
              ...input,
              mode: "json",
              query: '{"tenant":"a","id":"2"}',
            });
            assert.equal(rows.status, 200);
            assert.equal(rows.data.total, null);
            assert.equal(rows.data.documents.length, 1);
            const row = rows.data.documents[0];
            const update = {
              ...input,
              id: JSON.stringify(row.id),
              revision: row.revision,
              document: JSON.stringify({ ...row.value, name: "HTTP edited" }),
            };
            assert.equal((await post("update", update)).status, 200);
            assert.equal((await post("delete", update)).status, 409);
            assert.equal(
              (
                await post("delete", {
                  ...input,
                  collection: JSON.stringify([namespace, "no_key"]),
                })
              ).status,
              403,
            );
            const fresh = await post("documents", {
              ...input,
              mode: "json",
              query: '{"tenant":"a","id":"2"}',
            });
            assert.equal(fresh.data.documents[0].value.name, "HTTP edited");
            assert.equal(
              (
                await post("delete", {
                  ...update,
                  revision: fresh.data.documents[0].revision,
                })
              ).status,
              200,
            );
          } finally {
            if (apiToken) await post("disconnect");
          }
        },
      );
      await db.disconnect(token);
      assert.throws(() => db.sessionFor(token), /expired/);
    } finally {
      if (token) await db.disconnect(token);
      await pool.query(`DROP SCHEMA IF EXISTS ${qi(namespace)} CASCADE`);
      await pool.end();
    }
  },
);
