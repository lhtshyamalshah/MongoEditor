import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import {
  BSON,
  MongoClient,
  type Document,
  type MongoClientOptions,
} from "mongodb";
import { inferSchema } from "./schema";

export const EJSON = BSON.EJSON;
const MAX_TIME = 10_000;
const SESSION_TTL = 30 * 60_000;

export class AppError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

export function object(value: unknown, label: string): Document {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  )
    throw new AppError(`${label} must be a JSON object.`);
  return value as Document;
}

export function parseDocument(value: unknown, label: string): Document {
  if (typeof value !== "string" || value.length > 2_000_000)
    throw new AppError(`${label} must be JSON text under 2 MB.`);
  try {
    return object(EJSON.parse(value, { relaxed: false }), label);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(`${label} is not valid MongoDB Extended JSON.`);
  }
}

export function revision(document: Document): string {
  return createHash("sha256")
    .update(EJSON.stringify(document, { relaxed: false }))
    .digest("hex");
}

export function wireDocument(document: Document) {
  return {
    value: EJSON.serialize(document, { relaxed: false }),
    revision: revision(document),
  };
}

function name(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.includes("\0") ||
    value.length > 255
  )
    throw new AppError(`Choose a valid ${label}.`);
  return value;
}

export function profileNames(): string[] {
  return ["DB", "TENANT_DB", "MONGODB_URI", "MONGO_URI"].filter((key) =>
    /^mongodb(?:\+srv)?:\/\//.test(process.env[key] || ""),
  );
}

export function connectionOptions(uri: string): MongoClientOptions {
  const documentDb = /(?:\.|^)docdb\.amazonaws\.com(?=[:/,?]|$)/i.test(
    uri.split("@").at(-1) || "",
  );
  const options: MongoClientOptions = {
    serverSelectionTimeoutMS: 12_000,
    connectTimeoutMS: 10_000,
    socketTimeoutMS: 20_000,
    maxPoolSize: 5,
    minPoolSize: 0,
    // Keep Int32, Long and Double distinct when documents are edited.
    promoteValues: false,
    readPreference: "primary",
    appName: "local-mongo-browser",
  };
  const ca =
    process.env.MONGODB_TLS_CA_FILE || (documentDb ? "global-bundle.pem" : "");
  if (documentDb || ca) {
    // The certificate is read at runtime from the local workspace, not bundled.
    const caPath = path.resolve(/* turbopackIgnore: true */ process.cwd(), ca);
    if (!existsSync(caPath))
      throw new AppError(
        "The TLS certificate file is missing. Check MONGODB_TLS_CA_FILE or global-bundle.pem.",
      );
    Object.assign(options, { tls: true, tlsCAFile: caPath });
  }
  if (documentDb) Object.assign(options, { retryWrites: false });
  return options;
}

type Session = {
  client: MongoClient;
  label: string;
  touched: number;
  fields: Map<string, string[]>;
  databaseNames?: Promise<string[]>;
};
const globalStore = globalThis as typeof globalThis & {
  mongoBrowserSessions?: Map<string, Session>;
  mongoBrowserTimer?: ReturnType<typeof setInterval>;
};
const sessions = (globalStore.mongoBrowserSessions ??= new Map<
  string,
  Session
>());
if (!globalStore.mongoBrowserTimer) {
  globalStore.mongoBrowserTimer = setInterval(() => {
    for (const [token, session] of sessions)
      if (Date.now() - session.touched > SESSION_TTL) {
        sessions.delete(token);
        void session.client.close().catch(() => {});
      }
  }, 60_000);
  globalStore.mongoBrowserTimer.unref();
}

export function sessionFor(token: string | null): Session {
  const session = token ? sessions.get(token) : undefined;
  if (!session || Date.now() - session.touched > SESSION_TTL)
    throw new AppError(
      "Your connection expired. Connect again to continue.",
      401,
    );
  session.touched = Date.now();
  return session;
}

export async function disconnect(token: string | null) {
  if (!token) return;
  const session = sessions.get(token);
  sessions.delete(token);
  await session?.client.close();
}

export async function connect(input: Document) {
  if (sessions.size >= 20)
    throw new AppError(
      "Too many open connections. Disconnect an existing connection or wait for an idle connection to expire.",
      429,
    );
  const profile = typeof input.profile === "string" ? input.profile : "";
  const uri = profile
    ? profileNames().includes(profile)
      ? process.env[profile]
      : undefined
    : input.uri;
  if (
    typeof uri !== "string" ||
    !/^mongodb(?:\+srv)?:\/\//.test(uri) ||
    uri.length > 16_000
  )
    throw new AppError(
      "Enter a mongodb:// or mongodb+srv:// connection string.",
    );
  const client = new MongoClient(uri, connectionOptions(uri));
  try {
    await client.connect();
    const database =
      typeof input.database === "string" && input.database.trim()
        ? name(input.database.trim(), "database")
        : process.env.MONGODB_DATABASE || client.db().databaseName;
    await client.db(database).command({ ping: 1 });
    // Do not enumerate the cluster during connection. On large DocumentDB
    // clusters, listDatabases itself can contribute substantial database load.
    const token = randomBytes(32).toString("hex");
    sessions.set(token, {
      client,
      label: profile || "Custom connection",
      touched: Date.now(),
      fields: new Map(),
    });
    return {
      token,
      database,
      databases: [database],
      label: profile || "Custom connection",
      notice: "",
    };
  } catch (error) {
    await client.close().catch(() => {});
    throw error;
  }
}

export async function databases(session: Session) {
  // Explicit user action only. Cache both pending and completed requests so
  // repeated clicks do not run concurrent or repeated discovery commands.
  session.databaseNames ??= session.client
    .db("admin")
    .admin()
    .listDatabases({
      nameOnly: true,
      authorizedDatabases: true,
      maxTimeMS: MAX_TIME,
    })
    .then((result) =>
      [...new Set(result.databases.map((database) => database.name))].sort(),
    )
    .catch((error) => {
      session.databaseNames = undefined;
      throw error;
    });
  return { databases: await session.databaseNames };
}

function collectionFor(session: Session, input: Document) {
  return session.client
    .db(name(input.database, "database"))
    .collection(name(input.collection, "collection"));
}

export async function collections(session: Session, input: Document) {
  const result = await session.client
    .db(name(input.database, "database"))
    .listCollections({}, { nameOnly: true, authorizedCollections: true })
    .toArray();
  return {
    collections: result
      .map((item) => ({ name: item.name, type: item.type || "collection" }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

export function stringFields(documents: Document[]): string[] {
  const fields = new Set<string>();
  function walk(value: unknown, prefix: string, depth: number) {
    if (depth > 6 || fields.size >= 100) return;
    if (typeof value === "string") {
      if (prefix) fields.add(prefix);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 20)) walk(item, prefix, depth + 1);
      return;
    }
    if (
      !value ||
      typeof value !== "object" ||
      "_bsontype" in value ||
      value instanceof Date
    )
      return;
    for (const [key, item] of Object.entries(value))
      if (!key.startsWith("$") && !key.includes("."))
        walk(item, prefix ? `${prefix}.${key}` : key, depth + 1);
  }
  for (const document of documents) walk(document, "", 0);
  return [...fields].sort();
}

export async function schema(session: Session, input: Document) {
  const sample = await collectionFor(session, input)
    .find({}, { maxTimeMS: MAX_TIME })
    .sort({ _id: 1 })
    .limit(100)
    .toArray();
  session.fields.set(
    `${input.database}\0${input.collection}`,
    stringFields(sample),
  );
  return inferSchema(sample);
}

export function validateFilter(filter: Document) {
  function walk(value: unknown) {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (["$where", "$function", "$accumulator"].includes(key))
        throw new AppError(
          "Server-side JavaScript is not supported in filters.",
        );
      walk(child);
    }
  }
  walk(filter);
  return filter;
}

export function textFilter(text: string, fields: string[]): Document {
  const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const clauses: Document[] = fields.map((field) => ({
    [field]: { $regex: escaped, $options: "i" },
  }));
  if (/^[a-f\d]{24}$/i.test(text))
    clauses.push({ _id: new BSON.ObjectId(text) });
  return clauses.length ? { $or: clauses } : { _id: { $exists: false } };
}

export async function documents(session: Session, input: Document) {
  const collection = collectionFor(session, input);
  const page = Number(input.page ?? 1);
  const pageSize = Number(input.pageSize ?? 25);
  if (
    !Number.isSafeInteger(page) ||
    page < 1 ||
    page > 1_000_000 ||
    ![10, 25, 50, 100].includes(pageSize)
  )
    throw new AppError("Invalid page or page size.");
  const cacheKey = `${input.database}\0${input.collection}`;
  let fields = session.fields.get(cacheKey);
  if (!fields) {
    fields = stringFields(
      await collection.find({}, { maxTimeMS: MAX_TIME }).limit(100).toArray(),
    );
    session.fields.set(cacheKey, fields);
  }
  let filter: Document = {};
  if (input.mode === "json")
    filter = validateFilter(parseDocument(input.query || "{}", "Filter"));
  else if (typeof input.query === "string" && input.query.trim()) {
    if (input.query.length > 500)
      throw new AppError("Text searches must be 500 characters or fewer.");
    const searchFields = input.field
      ? [name(input.field, "search field")]
      : fields;
    if (searchFields.some((field) => field.startsWith("$")))
      throw new AppError("Invalid search field.");
    filter = textFilter(input.query.trim(), searchFields);
  }
  const [rows, total] = await Promise.all([
    collection
      .find(filter, { maxTimeMS: MAX_TIME })
      .sort({ _id: -1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize + 1)
      .toArray(),
    collection
      .countDocuments(filter, { maxTimeMS: MAX_TIME, promoteValues: true })
      .catch(() => null),
  ]);
  return {
    documents: rows.slice(0, pageSize).map(wireDocument),
    total: total === null ? null : Number(total),
    hasNext: rows.length > pageSize,
    page,
    pageSize,
    fields,
  };
}

export function exactId(value: unknown) {
  const document = parseDocument(value, "Document ID");
  if (!Object.hasOwn(document, "_id") || Object.keys(document).length !== 1)
    throw new AppError("A single document ID is required.");
  // $eq prevents object IDs supplied as JSON from becoming query operators.
  return { _id: { $eq: document._id } };
}

export function snapshotFilter(current: Document): Document {
  // Comparing the whole document as one $expr fails on large documents, so
  // match each top-level field and check the field count to catch added fields.
  const fields = Object.keys(current);
  return {
    ...Object.fromEntries(fields.map((key) => [key, { $eq: current[key] }])),
    $expr: { $eq: [{ $size: { $objectToArray: "$$ROOT" } }, fields.length] },
  };
}

export async function mutate(
  session: Session,
  input: Document,
  action: "update" | "delete",
) {
  const collection = collectionFor(session, input);
  if (input.collection.startsWith("system."))
    throw new AppError("System collections are read-only.", 403);
  const info = await session.client
    .db(input.database)
    .listCollections({ name: collection.collectionName }, { nameOnly: true })
    .next();
  if (!info) throw new AppError("This collection no longer exists.", 404);
  if (info.type === "view") throw new AppError("Views are read-only.", 403);
  const current = await collection.findOne(exactId(input.id), {
    maxTimeMS: MAX_TIME,
    readPreference: "primary",
  });
  if (!current)
    throw new AppError(
      "This document no longer exists. Refresh the collection.",
      404,
    );
  if (
    typeof input.revision !== "string" ||
    revision(current) !== input.revision
  )
    throw new AppError(
      "This document changed after you opened it. Refresh and reopen it before making changes.",
      409,
    );
  const filter = snapshotFilter(current);
  if (action === "delete") {
    const result = await collection.deleteOne(filter, {
      maxTimeMS: MAX_TIME,
      promoteValues: true,
      writeConcern: { w: "majority", wtimeoutMS: MAX_TIME },
    });
    if (Number(result.deletedCount) !== 1)
      throw new AppError(
        "The document changed before deletion. Refresh and try again.",
        409,
      );
    session.fields.delete(`${input.database}\0${input.collection}`);
    return { deleted: true };
  }
  const replacement = parseDocument(input.document, "Document");
  if (
    !Object.hasOwn(replacement, "_id") ||
    EJSON.stringify(replacement._id, { relaxed: false }) !==
      EJSON.stringify(current._id, { relaxed: false })
  )
    throw new AppError("The _id field cannot be changed or removed.");
  const result = await collection.replaceOne(filter, replacement, {
    maxTimeMS: MAX_TIME,
    upsert: false,
    promoteValues: true,
    writeConcern: { w: "majority", wtimeoutMS: MAX_TIME },
  });
  if (Number(result.matchedCount) !== 1)
    throw new AppError(
      "The document changed before saving. Refresh and try again.",
      409,
    );
  session.fields.delete(`${input.database}\0${input.collection}`);
  return { updated: true, document: wireDocument(replacement) };
}

export function publicError(error: unknown): {
  message: string;
  status: number;
} {
  if (error instanceof AppError)
    return { message: error.message, status: error.status };
  const item = error as { name?: string; code?: number; message?: string };
  if (item.code === 18 || /authentication failed/i.test(item.message || ""))
    return {
      message:
        "Authentication failed. Check the username, password, and authSource in your connection string.",
      status: 401,
    };
  if (item.code === 13)
    return {
      message:
        "Your database account does not have permission for this operation.",
      status: 403,
    };
  if (item.code === 11000)
    return {
      message:
        "A unique field already has this value. Choose a different value.",
      status: 409,
    };
  if (item.code === 50)
    return {
      message:
        "The query timed out. Try a more specific filter on an indexed field.",
      status: 408,
    };
  if (item.code === 121)
    return {
      message:
        "The document does not satisfy this collection’s validation rules.",
      status: 400,
    };
  if (/serverselection|network|timeout/i.test(item.name || ""))
    return {
      message:
        "Cannot reach the database. Check your VPN or network access, host, port, and TLS certificate. DocumentDB usually requires access to its VPC.",
      status: 503,
    };
  if (/certificate|tls|ssl/i.test(item.message || ""))
    return {
      message:
        "TLS verification failed. Check the certificate bundle and the connection hostname.",
      status: 503,
    };
  if (
    /parse|invalidargument|bson/i.test(item.name || "") ||
    [2, 9, 14, 52, 66, 168, 40324].includes(item.code || 0)
  )
    return {
      message:
        "The database rejected the document or filter. Check field names, types, and operators supported by your database.",
      status: 400,
    };
  return {
    message:
      "The database operation failed. Check your connection and whether your database supports this operation.",
    status: 500,
  };
}
