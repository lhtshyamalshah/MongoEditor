import { collections, connect, disconnect, documents, profileNames, publicError, sessionFor } from "../lib/database";
import { snapshotFilter } from "../lib/mongo";

// This diagnostic performs only connection, listing, and find operations.
// It never prints credentials, hostnames, document contents, or document IDs.
process.loadEnvFile(".env");

async function main() {
  const profiles = profileNames();
  if (!profiles.length) { console.log("No MongoDB or PostgreSQL connection profiles found in .env."); process.exitCode = 1; return; }
  for (const profile of profiles) {
    let token: string | undefined;
    try {
      const result = await connect({ profile }); token = result.token;
      console.log(`${profile}: connected to the default database; cluster-wide database discovery skipped.`);
      const session = sessionFor(token);
      const list = await collections(session, { database: result.database });
      console.log(`${profile}: ${list.collections.length} ${session.backend === "postgresql" ? "table(s)/view(s)" : "collection(s)"} in the default database.`);
      const candidates = list.collections.filter(item => item.type !== "view" && !item.name.startsWith("system.")).slice(0, 10);
      let verified = false;
      for (const candidate of candidates) {
        if (session.backend === "postgresql") {
          const rows = await documents(session, { database: result.database, collection: candidate.name, page: 1, pageSize: 10 });
          if (rows.documents.length) { console.log(`${profile}: PostgreSQL row read and pagination verified (read-only).`); verified = true; break; }
          continue;
        }
        const collection = session.session.client.db(result.database).collection(candidate.name);
        const document = await collection.findOne({}, { maxTimeMS: 10_000 });
        if (document) {
          const match = await collection.findOne(snapshotFilter(document), { maxTimeMS: 10_000 });
          if (!match) throw new Error("Snapshot match failed");
          console.log(`${profile}: document read and concurrent-change filter verified (read-only).`);
          verified = true;
          break;
        }
      }
      if (candidates.length && !verified) console.log(`${profile}: sampled collections are empty; no document snapshot was available.`);
    } catch (error) {
      console.log(`${profile}: ${publicError(error).message}`);
      const failure = error as { name?: string; code?: string; cause?: { code?: string }; reason?: { servers?: Map<string, { error?: { name?: string; code?: string; cause?: { code?: string } } }> } };
      const codes = [...(failure.reason?.servers?.values() || [])].map(server => ({ type: server.error?.name, code: server.error?.code, cause: server.error?.cause?.code }));
      console.log(JSON.stringify({ type: failure.name, code: failure.code, cause: failure.cause?.code, servers: codes }));
      process.exitCode = 1;
    }
    finally { if (token) await disconnect(token); }
  }
}
void main();
