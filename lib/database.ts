import * as mongo from "./mongo";
import * as postgres from "./postgres";

export { AppError, object } from "./mongo";
export function profileNames() {
  return [
    "DB",
    "TENANT_DB",
    "MONGODB_URI",
    "MONGO_URI",
    "POSTGRESQL_URI",
    "POSTGRES_URI",
    "DATABASE_URL",
  ].filter((key) =>
    /^(?:mongodb(?:\+srv)?|postgres(?:ql)?):\/\//.test(process.env[key] || ""),
  );
}
export async function connect(input: Record<string, unknown>) {
  const profile = typeof input.profile === "string" ? input.profile : "";
  const uri = profile
    ? profileNames().includes(profile)
      ? process.env[profile]
      : undefined
    : input.uri;
  if (
    typeof uri !== "string" ||
    uri.length > 16_000 ||
    !/^(?:mongodb(?:\+srv)?|postgres(?:ql)?):\/\//.test(uri)
  )
    throw new mongo.AppError(
      "Enter a MongoDB or PostgreSQL connection string.",
    );
  if (/^postgres(?:ql)?:/.test(uri))
    return postgres.connect({ ...input, uri, profile });
  return {
    ...(await mongo.connect({ ...input, profile: "", uri })),
    label: profile || "Custom connection",
    backend: "mongodb" as const,
  };
}
export async function disconnect(token: string | null) {
  if (postgres.hasSession(token)) return postgres.disconnect(token);
  return mongo.disconnect(token);
}
export function sessionFor(token: string | null) {
  return postgres.hasSession(token)
    ? { backend: "postgresql" as const, session: postgres.sessionFor(token) }
    : { backend: "mongodb" as const, session: mongo.sessionFor(token) };
}
type Session = ReturnType<typeof sessionFor>;
export const databases = (s: Session) =>
  s.backend === "postgresql"
    ? postgres.databases(s.session)
    : mongo.databases(s.session);
export const collections = (s: Session, input: Record<string, unknown>) =>
  s.backend === "postgresql"
    ? postgres.collections(s.session, input)
    : mongo.collections(s.session, input);
export const schema = (s: Session, input: Record<string, unknown>) =>
  s.backend === "postgresql"
    ? postgres.schema(s.session, input)
    : mongo.schema(s.session, input);
export const documents = (s: Session, input: Record<string, unknown>) =>
  s.backend === "postgresql"
    ? postgres.documents(s.session, input)
    : mongo.documents(s.session, input);
export const mutate = (
  s: Session,
  input: Record<string, unknown>,
  action: "update" | "delete",
) =>
  s.backend === "postgresql"
    ? postgres.mutate(s.session, input, action)
    : mongo.mutate(s.session, input, action);
export function query(s: Session, input: Record<string, unknown>) {
  if (s.backend !== "postgresql")
    throw new mongo.AppError(
      "The SQL editor is available for PostgreSQL connections.",
    );
  return postgres.query(s.session, input);
}
export function publicError(error: unknown) {
  return postgres.publicError(error) ?? mongo.publicError(error);
}
