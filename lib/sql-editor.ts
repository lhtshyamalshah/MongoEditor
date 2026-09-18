// Shared lexical helpers for bind parameters and lightweight metadata hints.
// PostgreSQL itself remains the SQL parser and enforces the read-only transaction.
export type SqlToken = { text: string; kind: "word" | "identifier" | "string" | "parameter" | "symbol"; from: number; to: number };
export type SqlTable = { name: string; label?: string; schema?: string; table?: string };

export function sqlTokens(sql: string, partial = false): SqlToken[] {
  const tokens: SqlToken[] = [];
  let i = 0;
  function incomplete(message: string) { if (!partial) throw new Error(message); i = sql.length; }
  while (i < sql.length) {
    const from = i, char = sql[i];
    if (/\s/.test(char)) { i++; continue; }
    if (sql.startsWith("--", i)) { const end = sql.indexOf("\n", i + 2); i = end < 0 ? sql.length : end + 1; continue; }
    if (sql.startsWith("/*", i)) {
      let depth = 1; i += 2;
      while (i < sql.length && depth) {
        if (sql.startsWith("/*", i)) { depth++; i += 2; }
        else if (sql.startsWith("*/", i)) { depth--; i += 2; }
        else i++;
      }
      if (depth) incomplete("Close the SQL block comment before running.");
      continue;
    }
    if (char === "'" || char === '"') {
      const escaped = char === "'" && tokens.at(-1)?.text.toLowerCase() === "e" && tokens.at(-1)?.to === i;
      i++; let closed = false;
      while (i < sql.length) {
        if (escaped && sql[i] === "\\") { i += 2; continue; }
        if (sql[i++] === char) {
          if (sql[i] === char) { i++; continue; }
          closed = true; break;
        }
      }
      if (!closed) incomplete("Close the quoted SQL value or identifier before running.");
      tokens.push({ text: sql.slice(from, i), kind: char === "'" ? "string" : "identifier", from, to: i }); continue;
    }
    const dollar = char === "$" ? sql.slice(i).match(/^\$(?:[a-z_][a-z_\d]*)?\$/i)?.[0] : undefined;
    if (dollar) {
      const end = sql.indexOf(dollar, i + dollar.length);
      if (end < 0) incomplete("Close the dollar-quoted SQL value before running."); else i = end + dollar.length;
      tokens.push({ text: sql.slice(from, i), kind: "string", from, to: i }); continue;
    }
    const parameter = char === "$" ? sql.slice(i).match(/^\$\d+/)?.[0] : undefined;
    if (parameter) { i += parameter.length; tokens.push({ text: parameter, kind: "parameter", from, to: i }); continue; }
    const word = sql.slice(i).match(/^[a-z_\u0080-\uffff][a-z_\d$\u0080-\uffff]*/i)?.[0];
    if (word) { i += word.length; tokens.push({ text: word, kind: "word", from, to: i }); continue; }
    i++; tokens.push({ text: char, kind: "symbol", from, to: i });
  }
  return tokens;
}

export function sqlParameters(sql: string, partial = false) {
  const numbers = [...new Set(sqlTokens(sql, partial).filter(token => token.kind === "parameter").map(token => Number(token.text.slice(1))))].sort((a, b) => a - b);
  if (numbers.some(number => !Number.isSafeInteger(number) || number < 1 || number > 50)) throw new Error("Use parameters $1 through $50.");
  return numbers;
}

export function prepareReadQuery(value: unknown, parameters: unknown, rowLimit: unknown) {
  if (typeof value !== "string" || !value.trim() || value.length > 50_000 || value.includes("\0")) throw new Error("Enter a SQL query under 50,000 characters.");
  const tokens = sqlTokens(value);
  if (tokens.at(-1)?.text === ";") tokens.pop();
  if (!tokens.length || tokens.some(token => token.kind === "symbol" && token.text === ";")) throw new Error("Run one SELECT or WITH query at a time.");
  if (tokens[0].kind !== "word" || !["SELECT", "WITH"].includes(tokens[0].text.toUpperCase())) throw new Error("The SQL editor supports read-only SELECT and WITH queries.");
  const forbidden = new Set(["INSERT", "UPDATE", "DELETE", "MERGE", "CREATE", "ALTER", "DROP", "TRUNCATE", "COPY", "CALL", "DO", "INTO", "LOCK", "SET", "RESET", "COMMIT", "ROLLBACK"]);
  if (tokens.some(token => token.kind === "word" && forbidden.has(token.text.toUpperCase()))) throw new Error("Write, locking, and session-control statements are not supported in the read-only editor.");
  let depth = 0;
  for (const token of tokens) if (token.kind === "symbol") {
    if (token.text === "(") depth++;
    if (token.text === ")" && --depth < 0) throw new Error("Check the SQL parentheses.");
  }
  if (depth) throw new Error("Check the SQL parentheses.");
  const sql = value.slice(0, tokens.at(-1)!.to).trim();
  const numbers = sqlParameters(sql);
  if (numbers.some((number, index) => number !== index + 1)) throw new Error("Use consecutive parameters starting at $1.");
  if (!Array.isArray(parameters) || parameters.length !== numbers.length || parameters.some(item => item !== null && (typeof item !== "string" || item.length > 100_000))) throw new Error("Supply one text value or SQL NULL for each parameter.");
  const limit = Number(rowLimit ?? 100);
  if (![25, 100, 500].includes(limit)) throw new Error("Choose a result limit of 25, 100, or 500 rows.");
  // An outer bound applies even when the user's query has no LIMIT. At least
  // one bind forces the extended protocol, which rejects multiple statements.
  return { text: `SELECT * FROM (\n${sql}\n) AS browser_query LIMIT $${parameters.length + 1}`, values: [...parameters, limit + 1], limit };
}

export function referencedTables(sql: string, tables: SqlTable[]) {
  const tokens = sqlTokens(sql, true);
  const names = new Set<string>();
  const identifier = (token?: SqlToken) => token?.kind === "identifier" ? token.text.slice(1, -1).replace(/""/g, '"') : token?.kind === "word" ? token.text.toLowerCase() : null;
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].kind !== "word" || !["FROM", "JOIN"].includes(tokens[i].text.toUpperCase())) continue;
    const first = identifier(tokens[i + 1]);
    const qualified = tokens[i + 2]?.text === ".";
    const second = qualified ? identifier(tokens[i + 3]) : null;
    for (const table of tables) if (qualified ? table.schema === first && table.table === second : table.table === first) names.add(table.name);
  }
  return [...names].slice(0, 5);
}
