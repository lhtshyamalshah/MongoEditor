# Mongo Browser

A local Next.js application for MongoDB and Amazon DocumentDB. Connect with a URI, choose a database and collection, browse every document with pagination, search, inspect, edit, and delete individual documents.

## Run

Requires Node.js 20.9 or newer.

```powershell
npm install
npm run dev
```

Open http://127.0.0.1:3000. Select a connection and click **Connect to database**. The app reads the existing `.env` automatically; the original environment file and certificate are not modified.

For a production build running on your machine:

```powershell
npm run build
npm start
```

## Connections

- `DB` and `TENANT_DB` are selectable profiles. `MONGODB_URI` and `MONGO_URI` are also recognized when configured.
- A custom URI can be entered in the connection form. It is held in server memory for the session and is not written to disk or browser storage.
- The URI's database is the default. The optional database input overrides it. `MONGODB_DATABASE` can also supply a default.
- Connecting opens the default database directly and lists only that database's collections. It does **not** issue `listDatabases` automatically. Use the **+** button to open another database by name; opened names remain in the selector for this connection.
- **Load all database names** is optional, explicitly triggered database discovery. It runs `listDatabases` with `nameOnly: true`, authorized databases only, and a query time limit. Concurrent requests share one operation, and the result is cached for the connection's lifetime. This command can still add load on large clusters; opening a known database name avoids it entirely. If discovery is denied, manual database entry remains available.
- MongoDB has databases containing collections, which contain documents. Dotted collection names are listed in full; nested document objects are visible in the document viewer.
- Amazon DocumentDB hostnames automatically enable TLS with `global-bundle.pem` and disable retryable writes. `MONGODB_TLS_CA_FILE` can override the certificate path. Standard MongoDB connections use their URI TLS settings unless a custom CA is configured.
- DocumentDB typically requires a VPN, VPC access, or a configured network tunnel. TLS hostname verification remains enabled.
- Sessions expire after 30 minutes of inactivity. Refreshing the browser requires reconnecting.

## Browse and edit

- **Collection schema** shows field paths (including nested objects and arrays), detected BSON types, and presence counts from up to 100 documents. This is an inferred sample, not a guaranteed or enforced schema. It remains independent of the current search and can be refreshed.
- Click a schema field, choose a value type and operator, then **Apply filter**. Supported operators include equality, inequality, text contains, comparisons, exists, and missing. Typed values preserve ObjectIds, dates, decimals, and 64-bit integers. The generated JSON filter appears in the search bar and replaces the previous search. **View all** clears it. Equals null matches fields present with a null value; use Is missing for absent fields.
- Schema inference caps traversal at 500 paths, 8 nesting levels, and 50 items per array. A notice appears if traversal is limited or literal field names containing dots or starting with `$` are omitted. Empty collections have no inferred schema.
- **View all** clears the current filter. Use page controls to browse the complete collection, in descending `_id` order, with 10–100 documents per page.
- **Text search** performs a case-insensitive literal substring match on string fields sampled from the first 100 documents, including nested fields and arrays. Enter a specific field path to search a field outside the sample. A 24-character ObjectId is also matched against `_id`.
- **JSON filter** accepts standard MongoDB find filters and Extended JSON. Examples: `{ "status": "active" }`, `{ "age": { "$gte": 18 } }`, or `{ "_id": { "$oid": "507f1f77bcf86cd799439011" } }`. Server-side JavaScript filters are disabled.
- **Table** shows `_id` and up to five fields discovered on the current page. **JSON** and the document viewer show all fields.
- Open a document, click **Edit document**, change the JSON, and save. Saving replaces the entire document; removed fields are removed from the database. `_id` cannot be changed.
- Canonical Extended JSON preserves BSON numeric types, dates, ObjectIds, and binary data. Keep wrappers such as `$numberLong` and `$date` when editing.
- Delete acts on one document, with confirmation. Views and system collections are read-only.
- Updates and deletes check the document revision and use an atomic full-document snapshot match. Concurrent changes produce a conflict rather than overwriting newer data. This requires `$expr`, `$literal`, and `$$ROOT`, supported by MongoDB and DocumentDB 4.0/5.0/8.0 instance-based clusters. Legacy DocumentDB 3.6 and elastic clusters are not supported for mutations by this implementation.
- Reads and counts have time limits. If a count times out, documents still display and the Next button remains available. Text search on a large collection can be expensive; use an indexed JSON filter when needed. Documents over 2 MB can be viewed but cannot be edited through this app.

## Local access

Development and production commands bind to `127.0.0.1`. API routes enforce local host and same-origin access. Connection URIs never appear in API responses. `.env`, certificates, build output, caches, and dependencies are excluded from Git. This is a local administration tool; it does not include authentication for hosting or sharing on a network.

## Verification

```powershell
npm run typecheck
npm test
npm run build
npm run check:connection
npm run check:http
```

Tests use isolated database doubles to cover BSON preservation, exact ID matching, search, conflict handling, deletion scope, and read-only restrictions. `check:connection` is a **read-only** diagnostic against configured profiles: connect, list, and find. It does not print documents, hostnames, or credentials, and performs no writes.

With the app running, `check:http` checks page rendering and API request protection. `npm run check:http -- --live` also checks the DB profile, collection listing, pagination, and exact document search through the API. These checks perform no writes.

Implementation references: [Next.js installation](https://nextjs.org/docs/app/getting-started/installation), [MongoDB Extended JSON](https://www.mongodb.com/docs/drivers/node/current/data-formats/extended-json/), [DocumentDB connections](https://docs.aws.amazon.com/documentdb/latest/devguide/connect_programmatically.html), and [DocumentDB operator compatibility](https://docs.aws.amazon.com/documentdb/latest/devguide/mongo-apis.html).
