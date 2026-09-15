import assert from "node:assert/strict";
import test from "node:test";
import { MongoClient } from "mongodb";
import { collections, connect, databases, disconnect, sessionFor } from "../lib/mongo";

test("connecting and listing collections never enumerates databases", async context => {
  const commands: object[] = [];
  let adminCalls = 0;
  let token: string | undefined;
  context.mock.method(MongoClient.prototype, "connect", async function(this: MongoClient) { return this; });
  context.mock.method(MongoClient.prototype, "close", async () => {});
  context.mock.method(MongoClient.prototype, "db", (databaseName: string) => ({
    databaseName,
    command: async (command: object) => { commands.push(command); return { ok: 1 }; },
    admin: () => { adminCalls++; throw new Error("Database discovery must not happen"); },
    listCollections: () => ({ toArray: async () => [{ name: "items", type: "collection" }] })
  }));
  try {
    const result = await connect({ uri: "mongodb://localhost:27017/example", database: "example" });
    token = result.token;
    assert.equal(result.database, "example");
    assert.deepEqual(result.databases, ["example"]);
    assert.deepEqual(await collections(sessionFor(token), { database: "example" }), { collections: [{ name: "items", type: "collection" }] });
    assert.equal(adminCalls, 0);
    assert.deepEqual(commands, [{ ping: 1 }]);
  } finally { if (token) await disconnect(token); }
});

test("explicit database discovery is name-only, bounded, deduplicated, and cached", async () => {
  let calls = 0;
  const session = { client: { db: () => ({ admin: () => ({ listDatabases: async (options: Record<string, unknown>) => {
    calls++; assert.equal(options.nameOnly, true); assert.equal(options.authorizedDatabases, true); assert.equal(options.maxTimeMS, 10_000);
    return { databases: [{ name: "z" }, { name: "a" }, { name: "a" }] };
  } }) }) } } as unknown as ReturnType<typeof sessionFor>;
  const results = await Promise.all([databases(session), databases(session)]);
  assert.deepEqual(results, [{ databases: ["a", "z"] }, { databases: ["a", "z"] }]);
  await databases(session);
  assert.equal(calls, 1);
});

test("failed discovery is retryable without invalidating the connection", async () => {
  let calls = 0;
  const session = { client: { db: () => ({ admin: () => ({ listDatabases: async () => {
    if (++calls === 1) throw new Error("Access denied");
    return { databases: [{ name: "allowed" }] };
  } }) }) } } as unknown as ReturnType<typeof sessionFor>;
  await assert.rejects(databases(session), /Access denied/);
  assert.deepEqual(await databases(session), { databases: ["allowed"] });
  assert.equal(calls, 2);
});
