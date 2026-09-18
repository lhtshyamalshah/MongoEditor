import assert from "node:assert/strict";
import test from "node:test";
import { collections, documents, schema, sessionFor } from "../lib/postgres";

function fixture(keyed = true) {
  const queries: { text: string; values: unknown[] }[] = [];
  let failMetadata = false;
  const pool = { query: async (text: string, values: unknown[] = []) => {
    queries.push({ text, values });
    if (text.includes("pg_attribute")) {
      if (failMetadata) { failMetadata = false; throw new Error("Catalog unavailable"); }
      return { rows: [
        { name: "id", type: "bigint", nullable: false, generated: false, keyPosition: keyed ? 2 : null, relkind: "r" },
        { name: "tenant", type: "text", nullable: false, generated: false, keyPosition: keyed ? 1 : null, relkind: "r" }
      ] };
    }
    if (text.includes("pg_class")) return { rows: [{ nspname: "public", relname: "items", owner: "app_owner", relkind: "r", pk: keyed }] };
    return { rows: Array.from({ length: keyed ? 11 : 10 }, (_, index) => ({ id: String(index + 1), tenant: "a" })) };
  } };
  const session = { uri: "", database: "test", touched: Date.now(), pools: new Map([["test", pool]]) } as unknown as ReturnType<typeof sessionFor>;
  const input = { database: "test", collection: '["public","items"]', pageSize: 10 };
  return { session, input, queries, failNextMetadata: () => { failMetadata = true; } };
}

test("opening both panels shares one catalog read; each page performs one bounded query and no count", async () => {
  const { session, input, queries } = fixture();
  const [first] = await Promise.all([documents(session, input), schema(session, input), schema(session, input)]);
  const second = await documents(session, { ...input, page: 2, after: first.nextCursor, mode: "json", query: '{"tenant":"a"}' });
  assert.equal(queries.filter(query => query.text.includes("pg_attribute")).length, 1);
  const rows = queries.filter(query => !query.text.includes("pg_catalog"));
  assert.equal(rows.length, 2);
  assert.ok(rows.every(query => !/count\s*\(|OFFSET/i.test(query.text)));
  assert.ok(rows.every(query => query.values.at(-1) === 11));
  assert.match(rows[1].text, /\(data\."tenant", data\."id"\) > \(\$2, \$3\)/);
  assert.match(rows[1].text, /ORDER BY data\."tenant", data\."id" LIMIT \$4/);
  assert.deepEqual(rows[1].values, ["a", "a", "10", 11]);
  assert.equal(first.total, null); assert.equal(second.total, null);
});

test("keyless previews do not sort, count, or skip rows", async () => {
  const { session, input, queries } = fixture(false);
  const result = await documents(session, input);
  const read = queries.at(-1)!;
  assert.doesNotMatch(read.text, /ORDER BY|OFFSET|count\s*\(/i);
  assert.equal(read.values.at(-1), 10);
  assert.equal(result.hasNext, false); assert.equal(result.pagination, "preview");
});

test("metadata refresh is explicit, expires after a minute, and shares concurrent refreshes", async context => {
  const { session, input, queries } = fixture();
  let now = 1_000;
  context.mock.method(Date, "now", () => now);
  await schema(session, input);
  await schema(session, input);
  assert.equal(queries.length, 1);
  await Promise.all([schema(session, { ...input, refresh: true }), schema(session, { ...input, refresh: true })]);
  assert.equal(queries.length, 2);
  now += 60_001;
  await schema(session, input);
  assert.equal(queries.length, 3);
});

test("table discovery is cached; failed metadata requests remain retryable", async () => {
  const { session, input, queries, failNextMetadata } = fixture();
  const [listing] = await Promise.all([collections(session, input), collections(session, input)]);
  assert.deepEqual(listing.collections[0], { name: '["public","items"]', label: '"public"."items"', schema: "public", table: "items", owner: "app_owner", type: "table", readOnly: false });
  await collections(session, input);
  assert.equal(queries.length, 1);
  await collections(session, { ...input, refresh: true });
  assert.equal(queries.length, 2);
  failNextMetadata();
  await assert.rejects(schema(session, input), /Catalog unavailable/);
  await schema(session, input);
  assert.equal(queries.length, 4);
});

test("unscoped text search and malformed cursors fail before any data scan", async () => {
  const { session, input, queries } = fixture();
  await assert.rejects(documents(session, { ...input, query: "needle" }), /Choose a search column/);
  await assert.rejects(documents(session, { ...input, after: { id: "1", tenant: { $ne: null } } }), /Invalid page cursor/);
  await assert.rejects(documents(session, { ...input, page: 500 }), /next-page cursor/);
  assert.equal(queries.length, 1);
});
