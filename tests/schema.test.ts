import assert from "node:assert/strict";
import test from "node:test";
import { BSON } from "mongodb";
import { inferSchema } from "../lib/schema";
import { buildFieldFilter } from "../lib/field-filter";
import { parseDocument, schema, sessionFor } from "../lib/mongo";

test("schema detects BSON types, nested fields, mixed types and missing fields", () => {
  const result = inferSchema([
    { _id: new BSON.ObjectId(), count: new BSON.Int32(2), amount: BSON.Decimal128.fromString("1.25"), large: BSON.Long.fromString("9007199254740993"), date: new Date(), enabled: true, user: { name: "Private name" }, optional: null },
    { _id: new BSON.ObjectId(), count: "two", user: { name: "Another name" } }
  ]);
  const field = (path: string) => result.fields.find(item => item.path === path)!;
  assert.equal(result.sampled, 2);
  assert.deepEqual(field("count").types, ["int", "string"]);
  assert.deepEqual(field("_id").types, ["objectId"]);
  assert.deepEqual(field("large").types, ["long"]);
  assert.deepEqual(field("date").types, ["date"]);
  assert.deepEqual(field("amount").types, ["decimal"]);
  assert.deepEqual(field("optional").types, ["null"]);
  assert.equal(field("optional").present, 1);
  assert.equal(field("user.name").present, 2);
  assert.ok(!JSON.stringify(result).includes("Private name"));
});

test("array fields count documents once and retain nested paths and item types", () => {
  const result = inferSchema([{ tags: ["a", "b"], orders: [{ total: new BSON.Double(1.5) }, { total: new BSON.Int32(3) }] }, { tags: [] }]);
  const tags = result.fields.find(field => field.path === "tags")!;
  assert.deepEqual(tags.types, ["array"]);
  assert.deepEqual(tags.itemTypes, ["string"]);
  assert.equal(tags.present, 2);
  const total = result.fields.find(field => field.path === "orders.total")!;
  assert.equal(total.present, 1);
  assert.deepEqual(total.types, ["double", "int"]);
});

test("empty schemas and traversal limits are explicit", () => {
  assert.deepEqual(inferSchema([]), { fields: [], sampled: 0, limited: false });
  const large = inferSchema([Object.fromEntries(Array.from({ length: 501 }, (_, index) => [`field${index}`, index]))]);
  assert.equal(large.fields.length, 500);
  assert.equal(large.limited, true);
  assert.equal(inferSchema([{ values: Array.from({ length: 51 }, () => "x") }]).limited, true);
  assert.equal(inferSchema([{ "literal.dot": 1, "$special": 2 }]).limited, true);
});

test("field filters preserve string values and escape regex characters", () => {
  assert.deepEqual(buildFieldFilter("user.name", "eq", "string", " true "), { "user.name": { $eq: " true " } });
  const filter = buildFieldFilter("email", "contains", "string", "a+b@example.com") as { email: { $regex: string; $options: string } };
  assert.ok(new RegExp(filter.email.$regex).test("a+b@example.com"));
  assert.ok(!new RegExp(filter.email.$regex).test("ab@exampleXcom"));
});

test("numeric, ObjectId, date and boolean filters parse into real BSON values", () => {
  const long = parseDocument(JSON.stringify(buildFieldFilter("total", "gte", "long", "9223372036854775807")), "Filter");
  assert.equal(long.total.$gte.toString(), "9223372036854775807");
  assert.equal(long.total.$gte._bsontype, "Long");
  const id = parseDocument(JSON.stringify(buildFieldFilter("_id", "eq", "objectId", "507f1f77bcf86cd799439011")), "Filter");
  assert.equal(id._id.$eq._bsontype, "ObjectId");
  const date = parseDocument(JSON.stringify(buildFieldFilter("createdAt", "lt", "date", "2026-09-11")), "Filter");
  assert.equal(date.createdAt.$lt.toISOString(), "2026-09-11T00:00:00.000Z");
  assert.deepEqual(buildFieldFilter("enabled", "eq", "boolean", "false"), { enabled: { $eq: false } });
});

test("invalid typed values are rejected rather than silently coerced", () => {
  for (const [type, value] of [["int", "1.5"], ["int", "2147483648"], ["long", "9223372036854775808"], ["double", ""], ["double", "Infinity"], ["double", "0x10"], ["boolean", "yes"], ["date", "nonsense"], ["date", "2026-09-11T10:00:00"], ["objectId", "123"], ["json", "{"]] as const) {
    assert.throws(() => buildFieldFilter("field", "eq", type, value));
  }
  assert.throws(() => buildFieldFilter("enabled", "gt", "boolean", "true"));
});

test("exists, missing and explicit null have distinct filters", () => {
  assert.deepEqual(buildFieldFilter("optional", "exists", "date", ""), { optional: { $exists: true } });
  assert.deepEqual(buildFieldFilter("optional", "missing", "date", ""), { optional: { $exists: false } });
  assert.deepEqual(buildFieldFilter("optional", "eq", "null", ""), { optional: { $eq: null, $exists: true } });
});

test("object values are equality operands, never injected query operators", () => {
  assert.deepEqual(buildFieldFilter("payload", "eq", "json", '{"$ne":null}'), { payload: { $eq: { $ne: null } } });
  assert.throws(() => buildFieldFilter("$where", "eq", "string", "x"));
});

test("schema reads an unfiltered bounded collection sample", async () => {
  let limit = 0;
  const sample = [{ title: "example", number: new BSON.Int32(1) }];
  const cursor = { sort: () => cursor, limit: (value: number) => { limit = value; return cursor; }, toArray: async () => sample };
  const collection = { find: (filter: object, options: { maxTimeMS: number }) => { assert.deepEqual(filter, {}); assert.ok(options.maxTimeMS > 0); return cursor; } };
  const session = { client: { db: () => ({ collection: () => collection }) }, fields: new Map() } as unknown as ReturnType<typeof sessionFor>;
  const result = await schema(session, { database: "db", collection: "items", query: "should not affect schema" });
  assert.equal(limit, 100);
  assert.equal(result.sampled, 1);
  assert.deepEqual(session.fields.get("db\0items"), ["title"]);
});
