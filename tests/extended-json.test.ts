import assert from "node:assert/strict";
import test from "node:test";
import { BSON } from "mongodb";
import { compactEjson } from "../lib/extended-json";
import { EJSON } from "../lib/mongo";

test("compact Extended JSON parses back to identical BSON types and values", () => {
  const original = {
    _id: new BSON.ObjectId(),
    int: new BSON.Int32(5),
    negativeInt: new BSON.Int32(-7),
    smallLong: BSON.Long.fromNumber(5),
    largeLong: BSON.Long.fromString("1735292689683"),
    hugeLong: BSON.Long.fromString("9223372036854775807"),
    wholeDouble: new BSON.Double(25000),
    largeWholeDouble: new BSON.Double(1735292689683),
    fraction: new BSON.Double(0.7),
    negativeZero: new BSON.Double(-0),
    nan: new BSON.Double(NaN),
    decimal: BSON.Decimal128.fromString("12.30"),
    date: new Date("2024-12-27T09:44:49.683Z"),
    earlyDate: new Date(5),
    oldDate: new Date("1900-01-01T00:00:00Z"),
    nested: [{ amount: new BSON.Int32(99900), when: new Date(0) }],
  };
  const canonical = EJSON.serialize(original, { relaxed: false });
  const compact = compactEjson(canonical);
  const back = EJSON.parse(JSON.stringify(compact), { relaxed: false });
  assert.equal(
    EJSON.stringify(back, { relaxed: false }),
    EJSON.stringify(original, { relaxed: false }),
  );
});

test("compact Extended JSON drops wrappers where the type is unambiguous", () => {
  const compact = compactEjson({
    a: { $numberInt: "5" },
    b: { $numberDouble: "0.7" },
    c: { $numberDouble: "25000.0" },
    d: { $date: { $numberLong: "1735292689683" } },
  });
  assert.deepEqual(compact, {
    a: 5,
    b: 0.7,
    c: { $numberDouble: "25000.0" },
    d: { $date: "2024-12-27T09:44:49.683Z" },
  });
});
