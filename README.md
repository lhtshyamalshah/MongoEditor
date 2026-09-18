# Database Browser

A local Next.js application for MongoDB, Amazon DocumentDB, and PostgreSQL. Connect with a URI, choose a database and collection or table, browse records with pagination, search, inspect, edit, and delete individual records.

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

### Windows Start menu

The **MongoEditor** shortcut runs `scripts/start-mongoeditor.ps1`, starts the service in a visible terminal using the same development command as `npm run dev` at http://127.0.0.1:3000, and opens your default browser. **Close the MongoEditor terminal or press Ctrl+C in it to stop the server.** Closing only the browser tab leaves the service running. Opening the shortcut again reuses the running service in its original terminal. It uses the current source and development environment files; no production build is required. Server output appears in the terminal, and its process ID is recorded in `.mongoeditor/server.pid`.

## Connections

- `DB` and `TENANT_DB` are selectable profiles. `MONGODB_URI` and `MONGO_URI` are also recognized when configured.
- PostgreSQL is detected automatically from `postgres://` or `postgresql://` URIs. `DB`, `TENANT_DB`, `POSTGRESQL_URI`, `POSTGRES_URI`, and `DATABASE_URL` can supply PostgreSQL profiles. Custom PostgreSQL URIs work in the same connection form. TLS settings come from the URI; for a verified TLS connection, use `sslmode=verify-full` and the appropriate trusted certificate configuration.
- A custom URI can be entered in the connection form. It is held in server memory for the session and is not written to disk or browser storage.
- The URI's database is the default. The optional database input overrides it. `MONGODB_DATABASE` can also supply a default.
- Connecting opens the default database directly and lists its collections or tables. It does **not** discover other databases automatically. Use the **+** button to open another database by name; opened names remain in the selector for this connection.
- **Load all database names** is optional, explicitly triggered database discovery. For MongoDB, it runs `listDatabases` with `nameOnly: true`, authorized databases only, and a query time limit. Concurrent requests share one operation, and the result is cached for the connection's lifetime. This command can still add load on large clusters; opening a known database name avoids it entirely. If discovery is denied, manual database entry remains available.
- MongoDB has databases containing collections, which contain documents. Dotted collection names are listed in full; nested document objects are visible in the document viewer.
- Amazon DocumentDB hostnames automatically enable TLS with `global-bundle.pem` and disable retryable writes. `MONGODB_TLS_CA_FILE` can override the certificate path. Standard MongoDB connections use their URI TLS settings unless a custom CA is configured.
- DocumentDB typically requires a VPN, VPC access, or a configured network tunnel. TLS hostname verification remains enabled.
- Sessions expire after 30 minutes of inactivity. Refreshing the browser requires reconnecting.

## PostgreSQL

Example local connection: `postgresql://username:password@localhost:5432/my_database`. The optional database field overrides the URI database; `POSTGRES_DATABASE` supplies an environment default. PostgreSQL's user/database defaults apply when neither is provided. URI-encode special characters in usernames and passwords.

Requires PostgreSQL 12 or newer; integration-tested with PostgreSQL 17.

- The sidebar lists accessible user tables, partitioned tables, views, and materialized views with schema-qualified names. System schemas are excluded. **Table schema** displays declared SQL types, nullability, primary keys, and generated columns, including for empty tables.
- **Text search** searches literal substrings across column text, or one exact column name. **JSON filter** supports `$eq`, `$ne`, `$gt`, `$gte`, `$lt`, `$lte`, and `$contains`. Conditions combine with AND. Examples: `{ "status": "active" }`, `{ "age": { "$gte": "18" } }`, and `{ "deleted_at": null }`. This is a bounded filter language, not a SQL console or the full MongoDB query language. Filter values are bound parameters; identifiers are quoted and checked against the table schema.
- Rows sort by their primary key in ascending order. Tables without a key and views sort by column text; identical rows have no guaranteed relative order. Pagination can shift if data changes between requests.
- The row editor represents every non-null value as a **JSON string containing PostgreSQL text format**, preserving big integers, decimals, timestamps with microseconds, JSON numbers, arrays, and binary values. SQL NULL is JSON `null`. For example, use `"amount": "123.450000001"`, `"enabled": "true"`, `"tags": "{one,two}"`, and `"payload": "{\"count\":9007199254740993}"`. PostgreSQL validates values against the column type when saving.
- Editing updates changed columns only. Keep every column in the JSON; primary key and generated columns cannot change. Single and composite primary keys are supported. Views and tables without a primary key are read-only. Database privileges, constraints, row security, and triggers still apply.
- Saving and deleting lock the selected row in a transaction and compare its current contents with the version opened in the browser. Concurrent changes produce a conflict. Deletion requires confirmation and targets exactly one primary key.
- Connecting does not enumerate databases. **+** opens another database by name; optional discovery lists databases with CONNECT permission. A session can open up to five databases, with at most three pooled connections per database. Queries time out after 10 seconds and lock waits after 5 seconds. Sessions expire after 30 minutes of inactivity.

## MongoDB / DocumentDB browsing and editing

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

PostgreSQL unit tests cover filters, identifier quoting, precision, profile detection, and sanitized errors. The PostgreSQL integration suite is optional and **writes only disposable test data** in a temporary schema. It requires a local database named `browser_test`:

```powershell
$env:TEST_POSTGRES_URI = 'postgresql://postgres:password@127.0.0.1:55432/browser_test'
npm test
Remove-Item Env:TEST_POSTGRES_URI
```

The integration suite covers real catalog discovery, numeric pagination, filters, lossless updates, composite keys (including INCLUDE columns), concurrent edits, exact deletion, and read-only restrictions. It removes its temporary schema after testing. Set `TEST_HTTP_BASE=http://127.0.0.1:3000` with the app running to additionally exercise these operations through the HTTP API against the same disposable data.

With the app running, `check:http` checks page rendering and API request protection. `npm run check:http -- --live` also checks the DB profile, collection listing, pagination, and exact document search through the API. These checks perform no writes.

For PostgreSQL HTTP checks, set `CHECK_DATABASE_PROFILE` to a PostgreSQL profile name, or `CHECK_DATABASE_URI` to a PostgreSQL URI, before running `npm run check:http -- --live`. `CHECK_HTTP_BASE` can override the default local server address.

PostgreSQL implementation references: [node-postgres parameterized queries](https://node-postgres.com/features/queries) and [transactions](https://node-postgres.com/features/transactions).

Implementation references: [Next.js installation](https://nextjs.org/docs/app/getting-started/installation), [MongoDB Extended JSON](https://www.mongodb.com/docs/drivers/node/current/data-formats/extended-json/), [DocumentDB connections](https://docs.aws.amazon.com/documentdb/latest/devguide/connect_programmatically.html), and [DocumentDB operator compatibility](https://docs.aws.amazon.com/documentdb/latest/devguide/mongo-apis.html).
