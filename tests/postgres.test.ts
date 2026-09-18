import assert from "node:assert/strict";
import test from "node:test";
import { compileFilter, quoteIdentifier, type PgColumn } from "../lib/postgres-filter";
import { poolOptions, publicError, relationName, wireRow } from "../lib/postgres";
import { profileNames } from "../lib/database";

const columns: PgColumn[] = ["id", "name", 'a.b"c'].map(name => ({ name, type: "text", nullable: true, primaryKey: name === "id", generated: false }));
test("PostgreSQL filters bind values, escape identifiers, and reject unsupported syntax", () => {
  const attack = "'; DROP TABLE users; --";
  const result = compileFilter({ name: attack, 'a.b"c': { $gte: "10" } }, columns);
  assert.equal(result.sql, '"name" = $1 AND "a.b""c" >= $2');
  assert.deepEqual(result.values, [attack, "10"]);
  assert.throws(() => compileFilter({ 'name; DROP TABLE users': "x" }, columns), /Unknown column/);
  for (const operator of ["$where", "$regex", "$or", "toString", "__proto__"]) assert.throws(() => compileFilter({ name: { [operator]: "x" } }, columns), /Unsupported/);
  assert.throws(() => compileFilter({ name: { $eq: { $gt: "x" } } }, columns), /Filter values/);
  assert.throws(() => compileFilter({ name: {} }, columns), /operator/);
});
test("PostgreSQL text search is literal and null filters use SQL null semantics", () => {
  const text = compileFilter({ name: { $contains: "50%_\\" } }, columns);
  assert.deepEqual(text.values, ["%50\\%\\_\\\\%"]);
  assert.equal(text.sql, '"name"::text ILIKE $1 ESCAPE E\'\\\\\'');
  assert.equal(compileFilter({ name: null, id: { $ne: null } }, columns).sql, '"name" IS NULL AND "id" IS NOT NULL');
  assert.throws(() => compileFilter({ name: { $gt: null } }, columns), /Use \$eq/);
});
test("schema-qualified names preserve dots and quotes and reject system tables", () => {
  assert.equal(relationName(JSON.stringify(['a.b', 'c"d'])).sql, '"a.b"."c""d"');
  assert.throws(() => relationName('["pg_catalog","pg_class"]'), /valid user table/);
  assert.throws(() => relationName('["public"]'), /valid user table/);
  assert.throws(() => quoteIdentifier("a\0b"), /Invalid/);
});
test("database overrides preserve URI credentials and TLS settings", () => {
  const options = poolOptions("postgresql://u:p%40ss@localhost:5432/old?sslmode=verify-full", "new db");
  const url = new URL(options.connectionString);
  assert.equal(decodeURIComponent(url.pathname), "/new db");
  assert.equal(url.password, "p%40ss");
  assert.equal(url.searchParams.get("sslmode"), "verify-full");
  assert.equal(options.statement_timeout, 5_000);
  assert.equal(options.max, 2);
  assert.equal(options.lock_timeout, 2_000);
});
test("row representation keeps numeric precision and composite identity separate", () => {
  const row = wireRow({ id: "9007199254740993", tenant: "a", amount: "1234567890.123456789", date: "2026-01-01 12:34:56.123456", json: '{"big":9007199254740993}' }, ["id", "tenant"]);
  assert.deepEqual(row.id, { id: "9007199254740993", tenant: "a" });
  assert.equal(row.value.amount, "1234567890.123456789");
  assert.notEqual(row.revision, wireRow({ ...row.value, amount: "0" }, ["id", "tenant"]).revision);
});
test("profiles discover both database engines without exposing connection strings", context => {
  for (const [key, value] of Object.entries({ DATABASE_URL: "postgresql://user:secret@host/db", POSTGRES_URI: "postgres://user:secret@host/db", DB: "mongodb://localhost/db", TENANT_DB: "https://not-a-database" })) {
    const previous = process.env[key];
    process.env[key] = value;
    context.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  }
  assert.ok(profileNames().includes("DATABASE_URL"));
  assert.ok(profileNames().includes("POSTGRES_URI"));
  assert.ok(profileNames().includes("DB"));
  assert.ok(!profileNames().includes("TENANT_DB"));
});
test("PostgreSQL errors are actionable without exposing raw database messages", () => {
  for (const [code, status] of [["28P01", 401], ["42501", 403], ["23505", 409], ["23503", 409], ["57014", 408], ["22P02", 400], ["ECONNREFUSED", 503]] as const) {
    const error = publicError({ code, message: "private database content" });
    assert.equal(error?.status, status);
    assert.ok(!error?.message.includes("private"));
  }
});
