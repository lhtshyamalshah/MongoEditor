import assert from "node:assert/strict";
import test from "node:test";
import { toCsv } from "../lib/sql-results";

test("CSV copy quotes separators, quotes and newlines, and keeps a header row", () => {
  const csv = toCsv(
    ["id", "note"],
    [
      ["1", 'say "hi", twice'],
      ["2", "line one\nline two"],
      ["3", "plain"],
    ],
  );
  assert.equal(
    csv,
    'id,note\r\n1,"say ""hi"", twice"\r\n2,"line one\nline two"\r\n3,plain',
  );
  assert.equal(csv.split("\r\n").length, 4);
});

test("CSV copy writes SQL NULL as an empty field and preserves text precision", () => {
  assert.equal(toCsv(["a", "b"], [[null, ""]]), "a,b\r\n,");
  assert.equal(
    toCsv(["amount"], [["123.450000001"], ["9007199254740993"]]),
    "amount\r\n123.450000001\r\n9007199254740993",
  );
  assert.equal(toCsv(["only,header"], []), '"only,header"');
});
