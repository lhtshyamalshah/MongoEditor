import assert from "node:assert/strict";

const base = "http://127.0.0.1:3000";
async function post(action: string, data: object = {}, token = "", extraHeaders: Record<string, string> = {}) {
  const response = await fetch(`${base}/api/mongo`, { method: "POST", headers: { "content-type": "application/json", "x-mongo-browser": "1", "x-connection-token": token, ...extraHeaders }, body: JSON.stringify({ action, ...data }) });
  return { status: response.status, data: await response.json() };
}

async function main() {
  const home = await fetch(base);
  assert.equal(home.status, 200);
  assert.ok((await home.text()).includes("Let’s connect"));
  const profileResponse = await fetch(`${base}/api/mongo`);
  assert.equal(profileResponse.status, 200);
  const { profiles } = await profileResponse.json();
  assert.ok(profiles.includes("DB") && profiles.includes("TENANT_DB"));
  assert.equal((await post("collections", { database: "test" })).status, 401);
  assert.equal((await post("connect", { profile: "DB" }, "", { origin: "https://untrusted.example" })).status, 403);
  assert.equal((await post("connect", { profile: "DB" }, "", { "x-mongo-browser": "" })).status, 403);
  assert.equal((await post("connect", { uri: "invalid" })).status, 400);
  const malformed = await fetch(`${base}/api/mongo`, { method: "POST", headers: { "content-type": "application/json", "x-mongo-browser": "1" }, body: "{" });
  assert.equal(malformed.status, 400);
  console.log("HTTP checks passed: page, profiles, session requirement, origin protection, and invalid request handling.");
  if (!process.argv.includes("--live")) return;
  let token = "";
  try {
    const result = await post("connect", { profile: "DB" });
    if (result.status !== 200) throw new Error(result.data.error);
    token = result.data.token;
    assert.equal(typeof token, "string");
    assert.equal(result.data.uri, undefined);
    const listing = await post("collections", { database: result.data.database }, token);
    assert.equal(listing.status, 200);
    console.log(`Live API: connection and ${listing.data.collections.length} collections verified.`);
    for (const collection of listing.data.collections.filter((item: { name: string; type: string }) => !item.name.startsWith("system.") && item.type !== "view").slice(0, 10)) {
      const input = { database: result.data.database, collection: collection.name, page: 1, pageSize: 10 };
      const rows = await post("documents", input, token);
      if (rows.status !== 200) throw new Error(rows.data.error);
      if (!rows.data.documents.length) continue;
      const first = rows.data.documents[0];
      const exact = await post("documents", { ...input, mode: "json", query: JSON.stringify({ _id: first.value._id }) }, token);
      assert.equal(exact.status, 200);
      assert.equal(exact.data.documents.length, 1);
      assert.equal(exact.data.documents[0].revision, first.revision);
      console.log("Live API: document pagination and exact Extended JSON search verified; no records changed.");
      break;
    }
  } finally { if (token) await post("disconnect", {}, token); }
}
main().catch(error => { console.log(`HTTP check failed: ${error.message}`); process.exitCode = 1; });
