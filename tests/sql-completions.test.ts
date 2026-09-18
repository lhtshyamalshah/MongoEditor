import assert from "node:assert/strict";
import test from "node:test";
import { EditorState } from "@codemirror/state";
import { CompletionContext } from "@codemirror/autocomplete";
import { PostgreSQL, schemaCompletionSource, sql } from "@codemirror/lang-sql";
import { completionNamespace } from "../lib/sql-completions";

const tables = [{ name: "users", schema: "public", table: "users" }, { name: "odd", schema: "a.b", table: 'odd.table"name' }];
const namespace = completionNamespace(tables, { users: { columns: [{ name: "id", type: "uuid", nullable: false, primaryKey: true, generated: false }, { name: "Display Name", type: "text", nullable: true, primaryKey: false, generated: false }], readOnly: false, reason: "" } });
async function suggestions(document: string, pos = document.length) {
  const config = { dialect: PostgreSQL, schema: namespace, defaultSchema: "public" };
  const state = EditorState.create({ doc: document, extensions: [sql(config)] });
  return (await schemaCompletionSource(config)(new CompletionContext(state, pos, true)))?.options || [];
}
test("SQL completion resolves table aliases and suggests typed, correctly quoted columns", async () => {
  const document = "SELECT u. FROM public.users u";
  const options = await suggestions(document, document.indexOf("u.") + 2);
  assert.equal(options.find(option => option.label === "id")?.detail, "uuid");
  assert.equal(options.find(option => option.label === "Display Name")?.apply, '"Display Name"');
});
test("SQL completion lists tables without reading rows and preserves literal dots and quotes", async () => {
  assert.ok((await suggestions("SELECT * FROM public.")).some(option => option.label === "users"));
  const options = await suggestions('SELECT * FROM "a.b".');
  assert.equal(options.find(option => option.label === 'odd.table"name')?.apply, '"odd.table""name"');
});
