import assert from "node:assert/strict";
import test from "node:test";
import { BSON, type Document } from "mongodb";
import { AppError, EJSON, connectionOptions, exactId, mutate, parseDocument, publicError, revision, sessionFor, snapshotFilter, stringFields, textFilter, validateFilter, wireDocument } from "../lib/mongo";

test("Extended JSON round trips BSON types without precision loss", () => {
  const original = { _id: new BSON.ObjectId(), large: BSON.Long.fromString("9223372036854775807"), decimal: BSON.Decimal128.fromString("12.30"), integer: new BSON.Int32(5), double: new BSON.Double(5), date: new Date("2026-01-01"), binary: new BSON.Binary(Buffer.from([0, 1, 255])), nested: { value: null } };
  const restored = parseDocument(JSON.stringify(wireDocument(original).value), "Document");
  assert.equal(revision(original), revision(restored));
  assert.equal(restored.large.toString(), "9223372036854775807");
  assert.equal(restored.integer._bsontype, "Int32");
  assert.equal(restored.double._bsontype, "Double");
});

test("document parsing rejects invalid JSON, arrays, scalars and oversize documents", () => {
  for (const value of ["{", "[]", "null", "1", '"text"', " ".repeat(2_000_001)]) assert.throws(() => parseDocument(value, "Document"), AppError);
});

test("text search treats regular expression characters literally", () => {
  const input = "test@example.com+(active)[1]";
  const filter = textFilter(input, ["user.email"]);
  const regex = new RegExp(filter.$or[0]["user.email"].$regex, "i");
  assert.ok(regex.test(input));
  assert.ok(!regex.test("test@exampleXcomactive1"));
});

test("text search supports ObjectIds and discovers nested string fields", () => {
  const fields = stringFields([{ _id: new BSON.ObjectId(), name: "A", user: { email: "a@example.com" }, tags: ["one", "two"], orders: [{ title: "First" }], created: new Date(), count: new BSON.Int32(1) }]);
  assert.deepEqual(fields, ["name", "orders.title", "tags", "user.email"]);
  const filter = textFilter("507f1f77bcf86cd799439011", []);
  assert.equal(filter.$or[0]._id.toHexString(), "507f1f77bcf86cd799439011");
});

test("filters reject embedded server-side JavaScript", () => {
  assert.throws(() => validateFilter({ $and: [{ $where: "return true" }] }), AppError);
  assert.throws(() => validateFilter({ $expr: { $function: {} } }), AppError);
  assert.deepEqual(validateFilter({ age: { $gte: 18 } }), { age: { $gte: 18 } });
});

test("ID selectors are exact equality, including object and null IDs", () => {
  assert.deepEqual(exactId('{"_id":{"$ne":null}}'), { _id: { $eq: { $ne: null } } });
  assert.deepEqual(exactId('{"_id":null}'), { _id: { $eq: null } });
  assert.throws(() => exactId("{}"), AppError);
  assert.throws(() => exactId('{"_id":"x","other":true}'), AppError);
});

function fixture(current: Document | null, outcome: number | BSON.Int32 = 1, type = "collection") {
  const writes: { action: string; filter: Document; replacement?: Document; options?: Document }[] = [];
  const collection = {
    collectionName: "items", findOne: async () => current,
    replaceOne: async (filter: Document, replacement: Document, options: Document) => { writes.push({ action: "update", filter, replacement, options }); return { matchedCount: outcome }; },
    deleteOne: async (filter: Document) => { writes.push({ action: "delete", filter }); return { deletedCount: outcome }; }
  };
  const db = { collection: () => collection, listCollections: () => ({ next: async () => ({ name: "items", type }) }) };
  const session = { client: { db: () => db }, label: "Test", touched: Date.now(), fields: new Map() } as unknown as ReturnType<typeof sessionFor>;
  const input = { database: "test", collection: "items", id: EJSON.stringify({ _id: current?._id ?? "missing" }), revision: current ? revision(current) : "missing" };
  return { session, input, writes };
}

test("save preserves ID and uses the entire snapshot in its atomic guard", async () => {
  const current = { _id: new BSON.ObjectId(), name: "Before", removed: true };
  const f = fixture(current);
  await mutate(f.session, { ...f.input, document: EJSON.stringify({ _id: current._id, name: "After" }) }, "update");
  assert.equal(f.writes.length, 1);
  assert.deepEqual(f.writes[0].filter, snapshotFilter(current));
  assert.equal(f.writes[0].replacement?.name, "After");
  assert.equal(f.writes[0].replacement?.removed, undefined);
  assert.equal(f.writes[0].options?.upsert, false);
});

test("save rejects changes to immutable IDs without writing", async () => {
  const f = fixture({ _id: "original", name: "Before" });
  await assert.rejects(mutate(f.session, { ...f.input, document: '{"_id":"other"}' }, "update"), /_id field/);
  assert.equal(f.writes.length, 0);
});

test("BSON numeric write counters are recognized as successful writes", async () => {
  for (const action of ["update", "delete"] as const) {
    const current = { _id: "one", value: "old" };
    const f = fixture(current, new BSON.Int32(1));
    const result = await mutate(f.session, { ...f.input, document: JSON.stringify(current) }, action);
    assert.equal(action === "update" ? result.updated : result.deleted, true);
  }
});

test("stale revisions and missing documents cannot be modified or deleted", async () => {
  for (const action of ["update", "delete"] as const) {
    const stale = fixture({ _id: "one", name: "New" });
    await assert.rejects(mutate(stale.session, { ...stale.input, revision: "stale" }, action), error => error instanceof AppError && error.status === 409);
    assert.equal(stale.writes.length, 0);
    const missing = fixture(null);
    await assert.rejects(mutate(missing.session, missing.input, action), error => error instanceof AppError && error.status === 404);
    assert.equal(missing.writes.length, 0);
  }
});

test("a concurrent change during saving or deletion is reported as conflict", async () => {
  for (const action of ["update", "delete"] as const) {
    const current = { _id: "one", value: "old" };
    const f = fixture(current, 0);
    await assert.rejects(mutate(f.session, { ...f.input, document: JSON.stringify(current) }, action), error => error instanceof AppError && error.status === 409);
  }
});

test("deletion uses one exact snapshot; system collections and views cannot be written", async () => {
  const current = { _id: "one", value: "old" };
  const f = fixture(current);
  await mutate(f.session, f.input, "delete");
  assert.equal(f.writes.length, 1);
  assert.deepEqual(f.writes[0].filter, snapshotFilter(current));
  const view = fixture(current, 1, "view");
  await assert.rejects(mutate(view.session, view.input, "delete"), /read-only/);
  await assert.rejects(mutate(view.session, { ...view.input, collection: "system.users" }, "delete"), /read-only/);
  assert.equal(view.writes.length, 0);
});

test("DocumentDB connections enable TLS and disable retryable writes", () => {
  const options = connectionOptions("mongodb://user:password@cluster.region.docdb.amazonaws.com:27017/db");
  assert.equal(options.tls, true);
  assert.equal(options.retryWrites, false);
  assert.equal(options.promoteValues, false);
  assert.equal(options.readPreference, "primary");
  assert.match(options.tlsCAFile || "", /global-bundle\.pem$/);
});

test("unknown database errors never expose credentials or server details", () => {
  const result = publicError(new Error("mongodb://secret:password@private-host/db"));
  assert.ok(!result.message.includes("secret"));
  assert.ok(!result.message.includes("private-host"));
  assert.equal(publicError({ code: 13 }).status, 403);
  assert.equal(publicError({ code: 18 }).status, 401);
});
