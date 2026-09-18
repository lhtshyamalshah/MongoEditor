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

- The sidebar lists accessible user tables, partitioned tables, views, and materialized views in collapsible groups. **Group by** switches between **Owner / user** (with schema sections inside each owner) and **Schema**. Search matches table names, schemas, and owners, expanding matching groups. Rows show the short table name; hover shows the qualified name and owner. Group counts reflect the visible table list. Owner means the PostgreSQL role that owns the table; grouping does not change database permissions. Owner/schema metadata comes from the existing cached catalog query, with no extra per-table requests. System schemas are excluded. **Table schema** displays declared SQL types, nullability, primary keys, and generated columns, including for empty tables.
- **Text search** requires one exact column name and searches literal substrings only in that column. It never automatically searches every column. Substring searches can still scan rows; prefer equality or range filters on indexed columns for large tables. **JSON filter** supports `$eq`, `$ne`, `$gt`, `$gte`, `$lt`, `$lte`, and `$contains`. Conditions combine with AND. Examples: `{ "status": "active" }`, `{ "age": { "$gte": "18" } }`, and `{ "deleted_at": null }`. This is a bounded filter language, not a SQL console or the full MongoDB query language. Filter values are bound parameters; identifiers are quoted and checked against the table schema.
- **Low-load reads:** no automatic `COUNT(*)`, background polling, prefetching, or cluster-wide discovery. Each page reads at most the requested 10–100 rows plus one lookahead row. Totals are deliberately omitted. Tables with a primary key use cursor pagination in primary-key index order, without `OFFSET` scans. Previous/Next reuse page cursors; refreshing starts at page one. Concurrent data changes can still change page contents.
- Tables without a primary key and views show a single limited, unsorted preview. There is no full-column sort or deep pagination fallback; apply a filter to narrow the preview. Complex views and unindexed filters can still be expensive even with a row limit.
- Table listings and declared schemas are cached for 60 seconds, with concurrent requests sharing the same catalog query. Refresh tables/schema explicitly to bypass the cache. Metadata is bounded to 100 entries per session; row contents are never cached. Reading or editing rows does not automatically refresh the schema panel. Mutations continue to validate fresh metadata.
- The row editor represents every non-null value as a **JSON string containing PostgreSQL text format**, preserving big integers, decimals, timestamps with microseconds, JSON numbers, arrays, and binary values. SQL NULL is JSON `null`. For example, use `"amount": "123.450000001"`, `"enabled": "true"`, `"tags": "{one,two}"`, and `"payload": "{\"count\":9007199254740993}"`. PostgreSQL validates values against the column type when saving.
- Editing updates changed columns only. Keep every column in the JSON; primary key and generated columns cannot change. Single and composite primary keys are supported. Views and tables without a primary key are read-only. Database privileges, constraints, row security, and triggers still apply.
- Saving and deleting lock the selected row in a transaction and compare its current contents with the version opened in the browser. Concurrent changes produce a conflict. Deletion requires confirmation and targets exactly one primary key.
- Connecting does not enumerate databases. **+** opens another database by name; optional discovery lists databases with CONNECT permission. A session can open up to five databases, with at most two pooled connections per database; idle connections close after 15 seconds. Queries time out after 5 seconds and lock waits after 2 seconds. Sessions expire after 30 minutes of inactivity.

## PostgreSQL SQL editor

After connecting to PostgreSQL, choose **SQL editor** beside **Browse tables**. The editor supports one read-only `SELECT` or `WITH ... SELECT` query per run, including joins and aggregate queries. SQL execution starts only when you click **Run query** or press **Ctrl/Command+Enter**. Switching between Browse and SQL keeps the current draft and parameters in memory; changing database/connection or reloading the page clears them.

- Syntax highlighting, line numbers, undo/redo, bracket matching, and **Ctrl+Space** autocomplete are provided by CodeMirror. **Tab** accepts the highlighted suggestion. Suggestions include PostgreSQL keywords, schema/table names, aliases, and column names with SQL types. Suggestions use local metadata, with no external AI service or row sampling.
- Only selected or `FROM`/`JOIN`-referenced tables load column metadata, debounced and capped at five tables per request cycle. The existing server metadata cache is reused. **Refresh suggestions** explicitly reloads those columns. Arbitrary SQL aliases and unusual query structures may require manually refreshing or selecting the relevant table.
- Write `$1`, `$2`, etc. to show separate parameter inputs. Numbers must start at `$1` with no gaps (up to `$50`); repeated uses share an input. Parameters inside comments and quoted strings are ignored. Values are bound through the driver, never interpolated into SQL. Enter PostgreSQL text values, or check **NULL**. For ambiguous types, add an explicit cast such as `$1::uuid`, `$1::numeric`, or `$1::timestamptz`. **Parameterized example** creates an equality filter for the selected table's primary key or first column.
- Each execution uses a PostgreSQL read-only transaction with a five-second statement timeout, a two-second lock timeout, and parallel query workers disabled. One console query runs per connection at a time. Writes, scripts, locking statements, and session-control commands are rejected. Execution uses the connected database role's permissions; the console is not an authentication or isolation layer for untrusted users.
- Results are capped at 25, 100, or 500 rows (default 100), plus one lookahead row, and a 2 MB serialized row-data budget. The server applies the row cap even if your SQL has no `LIMIT`. There is no automatic count or query execution while typing. Aggregates, joins, unindexed filters, and complex views can still do substantial work before returning rows; the row limit is not a scan limit.
- Results support table/JSON views and copying. Values remain PostgreSQL text to preserve numeric/timestamp precision; SQL NULL remains `null`. JSON uses separate column names and row arrays so duplicate result-column names are preserved. Result data is never automatically edited through the SQL console.

Example:

```sql
SELECT id, status
FROM public.your_table
WHERE status = $1
ORDER BY id
LIMIT 100;
```

Enter the desired status in **Parameter $1**, then run. Replace `your_table` and column names with autocomplete suggestions from your database.

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

PostgreSQL unit tests cover filters, identifier quoting, precision, profile detection, sanitized errors, metadata caching/deduplication, and query budgets (one bounded page query, no counts/offsets, and no sorting keyless previews). The PostgreSQL integration suite is optional and **writes only disposable test data** in a temporary schema. It requires a local database named `browser_test`:

```powershell
$env:TEST_POSTGRES_URI = 'postgresql://postgres:password@127.0.0.1:55432/browser_test'
npm test
Remove-Item Env:TEST_POSTGRES_URI
```

The integration suite covers real catalog discovery, cursor pagination (including deleted boundary rows and index order differing from column order), limited keyless previews, filters, lossless updates, composite keys (including INCLUDE columns), concurrent edits, exact deletion, and read-only restrictions. It removes its temporary schema after testing. Set `TEST_HTTP_BASE=http://127.0.0.1:3000` with the app running to additionally exercise these operations through the HTTP API against the same disposable data.

With the app running, `check:http` checks page rendering and API request protection. `npm run check:http -- --live` also checks the DB profile, collection listing, pagination, and exact document search through the API. These checks perform no writes.

For PostgreSQL HTTP checks, set `CHECK_DATABASE_PROFILE` to a PostgreSQL profile name, or `CHECK_DATABASE_URI` to a PostgreSQL URI, before running `npm run check:http -- --live`. `CHECK_HTTP_BASE` can override the default local server address.

PostgreSQL implementation references: [node-postgres parameterized queries](https://node-postgres.com/features/queries) and [transactions](https://node-postgres.com/features/transactions), plus PostgreSQL guidance on [LIMIT/OFFSET costs](https://www.postgresql.org/docs/current/queries-limit.html) and [aggregate costs](https://www.postgresql.org/docs/current/functions-aggregate.html).

Implementation references: [Next.js installation](https://nextjs.org/docs/app/getting-started/installation), [MongoDB Extended JSON](https://www.mongodb.com/docs/drivers/node/current/data-formats/extended-json/), [DocumentDB connections](https://docs.aws.amazon.com/documentdb/latest/devguide/connect_programmatically.html), and [DocumentDB operator compatibility](https://docs.aws.amazon.com/documentdb/latest/devguide/mongo-apis.html).
