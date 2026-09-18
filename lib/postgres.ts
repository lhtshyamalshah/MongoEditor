import { createHash, randomBytes } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { AppError, object } from "./mongo";
import { compileFilter, quoteIdentifier as qi, type PgColumn } from "./postgres-filter";
import { prepareReadQuery } from "./sql-editor";

type Input = Record<string, unknown>;
type Row = Record<string, string | null>;
type CacheEntry = { expires: number; pending: boolean; value: Promise<unknown> };
type Session = { uri: string; database: string; touched: number; pools: Map<string, Pool>; databaseNames?: Promise<string[]>; metadata?: Map<string, CacheEntry>; queryRunning?: boolean };
const TTL = 30 * 60_000;
const METADATA_TTL = 60_000;

// Share pending catalog reads between the rows and schema panels. Cache only
// metadata, never rows; mutations always validate fresh metadata under a lock.
async function cachedMetadata<T>(session: Session, key: string, load: () => Promise<T>, refresh = false): Promise<T> {
  const cache = session.metadata ??= new Map();
  const existing = cache.get(key);
  if (existing && (existing.pending || (!refresh && existing.expires > Date.now()))) return existing.value as Promise<T>;
  if (cache.size >= 100) cache.delete(cache.keys().next().value!);
  const entry: CacheEntry = { expires: 0, pending: true, value: Promise.resolve().then(load) };
  cache.set(key, entry);
  try { const value = await entry.value as T; entry.pending = false; entry.expires = Date.now() + METADATA_TTL; return value; }
  catch (error) { if (cache.get(key) === entry) cache.delete(key); throw error; }
}
const globalStore = globalThis as typeof globalThis & { postgresBrowserSessions?: Map<string, Session>; postgresBrowserTimer?: ReturnType<typeof setInterval> };
const sessions = globalStore.postgresBrowserSessions ??= new Map<string, Session>();
if (!globalStore.postgresBrowserTimer) {
  globalStore.postgresBrowserTimer = setInterval(() => {
    for (const [token, session] of sessions) if (Date.now() - session.touched > TTL) void disconnect(token);
  }, 60_000);
  globalStore.postgresBrowserTimer.unref();
}
function name(value: unknown, label: string) {
  if (typeof value !== "string" || !value || value.includes("\0") || Buffer.byteLength(value) > 63) throw new AppError(`Choose a valid ${label}.`);
  return value;
}
export function hasSession(token: string | null) { return !!token && sessions.has(token); }
export function sessionFor(token: string | null) {
  const session = token ? sessions.get(token) : undefined;
  if (!session || Date.now() - session.touched > TTL) throw new AppError("Your connection expired. Connect again to continue.", 401);
  session.touched = Date.now();
  return session;
}
export async function disconnect(token: string | null) {
  if (!token) return;
  const session = sessions.get(token);
  sessions.delete(token);
  await Promise.all([...session?.pools.values() || []].map(pool => pool.end().catch(() => {})));
}
export function poolOptions(uri: string, database?: string) {
  let url: URL;
  try { url = new URL(uri); } catch { throw new AppError("Enter a valid PostgreSQL connection string."); }
  if (!["postgres:", "postgresql:"].includes(url.protocol)) throw new AppError("Enter a postgres:// or postgresql:// connection string.");
  if (database) { url.pathname = `/${encodeURIComponent(name(database, "database"))}`; url.searchParams.delete("database"); }
  return { connectionString: url.toString(), max: 2, idleTimeoutMillis: 15_000, connectionTimeoutMillis: 10_000, statement_timeout: 5_000, lock_timeout: 2_000, idle_in_transaction_session_timeout: 15_000, application_name: "local-database-browser" };
}
function newPool(uri: string, database?: string) {
  const pool = new Pool(poolOptions(uri, database));
  // Idle socket failures must not terminate the local Next.js process.
  pool.on("error", () => {});
  return pool;
}
async function poolFor(session: Session, database: unknown) {
  const key = name(database, "database");
  const cached = session.pools.get(key);
  if (cached) return cached;
  if (session.pools.size >= 5) throw new AppError("Five databases are already open. Reconnect to open another database.");
  const pool = newPool(session.uri, key);
  session.pools.set(key, pool);
  try { await pool.query("SELECT 1"); return pool; }
  catch (error) { session.pools.delete(key); await pool.end().catch(() => {}); throw error; }
}
export async function connect(input: Input) {
  if (sessions.size >= 20) throw new AppError("Too many open connections. Disconnect an existing connection first.", 429);
  const uri = input.uri as string;
  const database = typeof input.database === "string" && input.database.trim() ? name(input.database.trim(), "database") : process.env.POSTGRES_DATABASE;
  const pool = newPool(uri, database);
  try {
    const result = await pool.query("SELECT current_database() AS database");
    const current = result.rows[0].database as string;
    const token = randomBytes(32).toString("hex");
    sessions.set(token, { uri, database: current, touched: Date.now(), pools: new Map([[current, pool]]) });
    return { token, database: current, databases: [current], backend: "postgresql" as const, label: input.profile || "Custom connection", notice: "" };
  } catch (error) { await pool.end().catch(() => {}); throw error; }
}
export async function databases(session: Session) {
  session.databaseNames ??= poolFor(session, session.database).then(pool => pool.query("SELECT datname FROM pg_catalog.pg_database WHERE datallowconn AND NOT datistemplate AND has_database_privilege(oid, 'CONNECT') ORDER BY datname"))
    .then(result => result.rows.map(row => row.datname as string)).catch(error => { session.databaseNames = undefined; throw error; });
  return { databases: await session.databaseNames };
}
// Relation IDs are a JSON pair so names containing dots remain unambiguous.
export function relationName(value: unknown) {
  try {
    const pair = JSON.parse(String(value));
    if (!Array.isArray(pair) || pair.length !== 2) throw new Error();
    const schema = name(pair[0], "schema"), table = name(pair[1], "table");
    if (schema === "information_schema" || schema.startsWith("pg_")) throw new Error();
    return { schema, table, sql: `${qi(schema)}.${qi(table)}` };
  } catch { throw new AppError("Choose a valid user table."); }
}
export async function collections(session: Session, input: Input) {
  const pool = await poolFor(session, input.database);
  return cachedMetadata(session, JSON.stringify([input.database, "tables"]), async () => {
    const result = await pool.query(`SELECT n.nspname, c.relname, c.relkind, pg_catalog.pg_get_userbyid(c.relowner) AS owner,
      EXISTS (SELECT 1 FROM pg_catalog.pg_index i WHERE i.indrelid = c.oid AND i.indisprimary AND i.indisvalid) AS pk
      FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r', 'p', 'v', 'm') AND n.nspname <> 'information_schema' AND n.nspname !~ '^pg_'
      AND has_schema_privilege(n.oid, 'USAGE') AND has_table_privilege(c.oid, 'SELECT') ORDER BY n.nspname, c.relname`);
    return { collections: result.rows.map(row => ({ name: JSON.stringify([row.nspname, row.relname]), label: `${qi(row.nspname)}.${qi(row.relname)}`, schema: row.nspname as string, table: row.relname as string, owner: row.owner as string, type: ["v", "m"].includes(row.relkind) ? "view" : "table", readOnly: !row.pk || !["r", "p"].includes(row.relkind) })) };
  }, input.refresh === true);
}
async function tableInfo(client: Pool | PoolClient, collection: unknown) {
  const relation = relationName(collection);
  const result = await client.query(`SELECT a.attname AS name, pg_catalog.format_type(a.atttypid, a.atttypmod) AS type,
    NOT a.attnotnull AS nullable, a.attgenerated <> '' AS generated, c.relkind,
    (SELECT k.position::int FROM pg_catalog.pg_index i, unnest(i.indkey) WITH ORDINALITY k(attnum, position)
      WHERE i.indrelid = c.oid AND i.indisprimary AND i.indisvalid AND k.position <= i.indnkeyatts AND a.attnum = k.attnum) AS "keyPosition"
    FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid = a.attrelid JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind IN ('r', 'p', 'v', 'm') AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`, [relation.schema, relation.table]);
  if (!result.rows.length) throw new AppError("This table no longer exists or has no columns.", 404);
  const columns = result.rows.map(({ name, type, nullable, generated, keyPosition }) => ({ name, type, nullable, generated, primaryKey: keyPosition !== null })) as PgColumn[];
  // Match the primary-key index order, which can differ from column order.
  const primaryKeys = result.rows.filter(column => column.keyPosition !== null).sort((a, b) => a.keyPosition - b.keyPosition).map(column => column.name as string);
  const readOnly = !["r", "p"].includes(result.rows[0].relkind) || !primaryKeys.length;
  return { ...relation, columns, primaryKeys, readOnly, reason: readOnly ? "Views and tables without a primary key are read-only." : "" };
}
function readTableInfo(session: Session, pool: Pool, input: Input) {
  return cachedMetadata(session, JSON.stringify([input.database, "schema", input.collection]), () => tableInfo(pool, input.collection), input.refresh === true);
}
export async function schema(session: Session, input: Input) {
  const { columns, readOnly, reason } = await readTableInfo(session, await poolFor(session, input.database), input);
  return { columns, readOnly, reason };
}
export async function query(session: Session, input: Input) {
  let prepared;
  try { prepared = prepareReadQuery(input.sql, input.parameters ?? [], input.rowLimit); }
  catch (error) { throw new AppError((error as Error).message); }
  if (session.queryRunning) throw new AppError("A SQL query is already running for this connection.", 429);
  session.queryRunning = true;
  let client: PoolClient | undefined;
  let reusable = false;
  const started = Date.now();
  try {
    client = await (await poolFor(session, input.database)).connect();
    await client.query("BEGIN READ ONLY");
    await client.query("SET LOCAL statement_timeout = '5s'");
    await client.query("SET LOCAL lock_timeout = '2s'");
    await client.query("SET LOCAL max_parallel_workers_per_gather = 0");
    await client.query("SET LOCAL standard_conforming_strings = on");
    const result = await client.query<(string | null)[]>({ text: prepared.text, values: prepared.values, rowMode: "array", types: { getTypeParser: () => (value: string) => value } });
    const rows: (string | null)[][] = [];
    let bytes = 0;
    for (const row of result.rows.slice(0, prepared.limit)) {
      bytes += Buffer.byteLength(JSON.stringify(row));
      if (bytes > 2_000_000) break;
      rows.push(row);
    }
    const truncated = result.rows.length > rows.length;
    return { columns: result.fields.map(field => ({ name: field.name, typeOid: field.dataTypeID })), rows, truncated, rowLimit: prepared.limit, durationMs: Date.now() - started, notice: bytes > 2_000_000 ? "Results exceed 2 MB. Select fewer or smaller columns." : truncated ? `Showing the first ${prepared.limit} rows. Narrow the query to see other results.` : "" };
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "25006") throw new AppError("The SQL editor is read-only. This query attempted to change data.", 403);
    if (code === "42601") throw new AppError("SQL syntax error. Check the query and run one SELECT or WITH statement.");
    if (code === "42P01") throw new AppError("A table or view was not found. Use its schema-qualified name from autocomplete.");
    if (code === "42703") throw new AppError("A column was not found. Check the column suggestions and table aliases.");
    if (code === "42P18" || code === "42804") throw new AppError("PostgreSQL could not infer a parameter type. Add a cast such as $1::uuid or $1::text.");
    throw error;
  } finally {
    if (client) {
      try {
        await client.query("ROLLBACK");
        // SELECT can call functions that change session settings or acquire
        // advisory locks. Do not leak those into later pooled operations.
        await client.query("DISCARD ALL");
        reusable = true;
      } catch { /* Destroy the connection if cleanup fails. */ }
      client.release(!reusable);
    }
    session.queryRunning = false;
  }
}
function projection(columns: PgColumn[]) { return columns.map(column => `${qi(column.name)}::text AS ${qi(column.name)}`).join(", "); }
export function wireRow(value: Row, keys: string[]) {
  return { value, id: Object.fromEntries(keys.map(key => [key, value[key]])), revision: createHash("sha256").update(JSON.stringify(value)).digest("hex") };
}
export async function documents(session: Session, input: Input) {
  const pool = await poolFor(session, input.database);
  const table = await readTableInfo(session, pool, input);
  const page = Number(input.page ?? 1), pageSize = Number(input.pageSize ?? 25);
  if (!Number.isSafeInteger(page) || page < 1 || page > 1_000_000 || ![10, 25, 50, 100].includes(pageSize)) throw new AppError("Invalid page or page size.");
  let filter = { sql: "TRUE", values: [] as unknown[] };
  try {
    if (input.mode === "json") {
      if (typeof input.query !== "string" || input.query.length > 2_000_000) throw new Error("Enter a JSON filter under 2 MB.");
      filter = compileFilter(object(JSON.parse(input.query || "{}"), "Filter"), table.columns);
    } else if (typeof input.query === "string" && input.query.trim()) {
      if (input.query.length > 500) throw new Error("Text searches must be 500 characters or fewer.");
      if (typeof input.field !== "string" || !table.columns.some(column => column.name === input.field)) throw new Error("Choose a search column to avoid searching every column. Indexed JSON filters are preferable on large tables.");
      filter = compileFilter({ [input.field]: { $contains: input.query.trim() } }, table.columns);
    }
  } catch (error) { throw new AppError(error instanceof SyntaxError ? "Enter a valid JSON filter." : (error as Error).message); }
  const keyed = table.primaryKeys.length > 0;
  if (!keyed && (page !== 1 || input.after != null)) throw new AppError("Tables without a primary key show one limited preview. Apply a filter to narrow the results.");
  if (keyed && page > 1 && input.after == null) throw new AppError("Use the next-page cursor to continue browsing. Refresh to restart.");
  if (input.after != null) {
    const after = object(input.after, "Page cursor");
    if (Object.keys(after).length !== table.primaryKeys.length || table.primaryKeys.some(key => !Object.hasOwn(after, key) || typeof after[key] !== "string")) throw new AppError("Invalid page cursor. Refresh to restart.");
    const parameters = table.primaryKeys.map(key => { filter.values.push(after[key]); return `$${filter.values.length}`; });
    filter.sql = `(${filter.sql}) AND (${table.primaryKeys.map(key => `data.${qi(key)}`).join(", ")}) > (${parameters.join(", ")})`;
  }
  const order = keyed ? ` ORDER BY ${table.primaryKeys.map(key => `data.${qi(key)}`).join(", ")}` : "";
  // One bounded row query. Never count the whole table, sort all columns, or
  // skip earlier pages. The extra row tells the UI whether Next is available.
  let result;
  try {
    result = await pool.query(`SELECT ${projection(table.columns)} FROM ${table.sql} AS data WHERE ${filter.sql}${order} LIMIT $${filter.values.length + 1}`, [...filter.values, keyed ? pageSize + 1 : pageSize]);
  } catch (error) {
    // A schema change should be retryable without waiting for the cache TTL.
    session.metadata?.delete(JSON.stringify([input.database, "schema", input.collection]));
    throw error;
  }
  const rows = result.rows.slice(0, pageSize).map(row => wireRow(row, table.primaryKeys));
  const hasNext = keyed && result.rows.length > pageSize;
  return { documents: rows, total: null, hasNext, nextCursor: hasNext ? rows.at(-1)!.id : null, pagination: keyed ? "keyset" : "preview", notice: keyed ? "" : "Limited preview: this table or view has no primary key. Apply a filter to narrow the results. Rows are not sorted.", fields: table.columns.map(column => column.name), readOnly: table.readOnly, page, pageSize };
}
function parseRow(value: unknown, label: string): Input {
  if (typeof value !== "string" || value.length > 2_000_000) throw new AppError(`${label} must be JSON text under 2 MB.`);
  try { return object(JSON.parse(value), label); } catch { throw new AppError(`${label} must be a JSON object.`); }
}
export async function mutate(session: Session, input: Input, action: "update" | "delete") {
  const client = await (await poolFor(session, input.database)).connect();
  try {
    await client.query("BEGIN");
    const table = await tableInfo(client, input.collection);
    if (table.readOnly) throw new AppError(table.reason, 403);
    // Prevent concurrent DDL from changing the key or relation after validation.
    await client.query(`LOCK TABLE ${table.sql} IN ROW EXCLUSIVE MODE`);
    const verified = await tableInfo(client, input.collection);
    if (JSON.stringify(verified) !== JSON.stringify(table)) throw new AppError("The table schema changed. Refresh and try again.", 409);
    const id = parseRow(input.id, "Row key");
    if (Object.keys(id).length !== table.primaryKeys.length || table.primaryKeys.some(key => !Object.hasOwn(id, key) || typeof id[key] !== "string")) throw new AppError("The complete primary key is required.");
    const values = table.primaryKeys.map(key => id[key]);
    const where = table.primaryKeys.map((key, index) => `${qi(key)} = $${index + 1}`).join(" AND ");
    const found = await client.query(`SELECT ${projection(table.columns)} FROM ${table.sql} WHERE ${where} FOR UPDATE`, values);
    if (!found.rows.length) throw new AppError("This row no longer exists. Refresh the table.", 404);
    if (found.rows.length !== 1) throw new AppError("The key does not identify exactly one row.", 409);
    const current = found.rows[0] as Row;
    if (wireRow(current, table.primaryKeys).revision !== input.revision) throw new AppError("This row changed after you opened it. Refresh and reopen it before making changes.", 409);
    if (action === "delete") {
      const result = await client.query(`DELETE FROM ${table.sql} WHERE ${where}`, values);
      if (result.rowCount !== 1) throw new AppError("The row could not be deleted.", 409);
    } else {
      const next = parseRow(input.document, "Row");
      if (Object.keys(next).length !== table.columns.length || table.columns.some(column => !Object.hasOwn(next, column.name))) throw new AppError("Keep every column in the row. Use null for SQL NULL.");
      const changed = table.columns.filter(column => next[column.name] !== current[column.name]);
      for (const column of changed) {
        if (column.primaryKey || column.generated) throw new AppError("Primary key and generated columns cannot be changed.");
        if (next[column.name] !== null && typeof next[column.name] !== "string") throw new AppError("Use strings for PostgreSQL values, or null for SQL NULL.");
      }
      if (changed.length) {
        const set = changed.map(column => { values.push(next[column.name]); return `${qi(column.name)} = $${values.length}`; }).join(", ");
        const result = await client.query(`UPDATE ${table.sql} SET ${set} WHERE ${where}`, values);
        if (result.rowCount !== 1) throw new AppError("The row could not be updated.", 409);
      }
    }
    await client.query("COMMIT");
    return action === "delete" ? { deleted: true } : { updated: true };
  } catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; }
  finally { client.release(); }
}
export function publicError(error: unknown) {
  if (error instanceof AppError) return { message: error.message, status: error.status };
  const code = (error as { code?: string })?.code;
  if (code === "28P01" || code === "28000") return { message: "PostgreSQL authentication failed. Check your username and password.", status: 401 };
  if (code === "42501") return { message: "Your database account does not have permission for this operation.", status: 403 };
  if (code === "3D000") return { message: "The requested PostgreSQL database does not exist.", status: 404 };
  if (code === "23505") return { message: "A unique column already has this value.", status: 409 };
  if (code === "23503") return { message: "This change conflicts with a foreign key constraint.", status: 409 };
  if (code === "57014" || code === "55P03") return { message: "The query or lock timed out. Try a more specific filter or retry later.", status: 408 };
  if (code === "40001" || code === "40P01") return { message: "A concurrent transaction conflicted with this change. Refresh and try again.", status: 409 };
  if (code && /^(22|23|42)/.test(code)) return { message: "PostgreSQL rejected the value or filter. Check column types, operators, and table constraints.", status: 400 };
  if (["ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT", "ECONNRESET"].includes(code || "")) return { message: "Cannot reach PostgreSQL. Check the host, port, VPN, and connection settings.", status: 503 };
  return null;
}
