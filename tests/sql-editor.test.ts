import assert from "node:assert/strict";
import test from "node:test";
import {
  prepareReadQuery,
  referencedTables,
  sqlParameters,
} from "../lib/sql-editor";

test("parameters ignore quoted values, identifiers, dollar strings and nested comments", () => {
  const query = `SELECT $2, $1, $2, '$3', "$4", $$ $5 ; delete $$, $tag$ $6 $tag$, E'it\\'s $7'
    -- $8
    /* $9 /* $10 */ still comment */`;
  assert.deepEqual(sqlParameters(query), [1, 2]);
  assert.deepEqual(sqlParameters("SELECT $1, 'unfinished $2", true), [1]);
  assert.throws(() => sqlParameters("SELECT $0"), /\$1 through \$50/);
  assert.throws(
    () => sqlParameters("SELECT $999999999999999"),
    /\$1 through \$50/,
  );
});
test("read query validation accepts SELECT and read CTEs, preserves binds and bounds results", () => {
  const prepared = prepareReadQuery(
    "/* header */ WITH x AS (SELECT $1::text AS value) SELECT * FROM x; -- trailing",
    ["';DELETE FROM x;--"],
    25,
  );
  assert.match(prepared.text, /^SELECT \* FROM \(/);
  assert.match(prepared.text, /AS browser_query LIMIT \$2$/);
  assert.deepEqual(prepared.values, ["';DELETE FROM x;--", 26]);
  assert.equal(prepared.limit, 25);
  assert.ok(prepareReadQuery("SELECT ';' AS semi, 'delete' AS word", [], 100));
  assert.ok(prepareReadQuery('SELECT "update" FROM "data"', [], 100));
});
test("SQL validation rejects scripts, write CTEs, wrapper escapes and invalid parameters", () => {
  for (const sql of [
    "DELETE FROM x",
    "UPDATE x SET a=1",
    "WITH x AS (DELETE FROM y RETURNING *) SELECT * FROM x",
    "SELECT 1; DELETE FROM x",
    "SELECT 1; SELECT 2",
    "SELECT * INTO tmp FROM x",
    "SELECT * FROM x FOR UPDATE",
    "SELECT 1) AS x",
    "SELECT (1",
    "SELECT 'unclosed",
    "SELECT $$unclosed",
    "SELECT 1 /* unclosed",
  ])
    assert.throws(() => prepareReadQuery(sql, [], 100));
  assert.throws(
    () => prepareReadQuery("SELECT $2::text", ["x"], 100),
    /consecutive/,
  );
  assert.throws(() => prepareReadQuery("SELECT $1", [], 100), /one text value/);
  assert.throws(
    () => prepareReadQuery("SELECT $1", [{ value: "x" }], 100),
    /one text value/,
  );
  assert.throws(() => prepareReadQuery("SELECT 1", [], 10_000), /result limit/);
  assert.throws(
    () => prepareReadQuery("SELECT " + " ".repeat(50_000), [], 100),
    /50,000/,
  );
});
test("column hints load only referenced known tables and recognize quoted names", () => {
  const tables = [
    { name: "users", schema: "public", table: "users" },
    { name: "orders", schema: "sales", table: 'order.items"quoted' },
    { name: "ignored", schema: "public", table: "ignored" },
  ];
  assert.deepEqual(
    referencedTables(
      'SELECT u.id FROM public.users u JOIN "sales"."order.items""quoted" o ON o.id=u.id -- FROM ignored',
      tables,
    ),
    ["users", "orders"],
  );
  assert.deepEqual(
    referencedTables("SELECT 'FROM ignored' FROM users", tables),
    ["users"],
  );
});
