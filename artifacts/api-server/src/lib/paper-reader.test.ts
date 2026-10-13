// node --import tsx --test artifacts/api-server/src/lib/paper-reader.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { matchName, parseRosterLines, parseSubjectLines, titleCase } from "./paper-reader";

// A class list as a phone actually reads one back: a header band, an S/N
// gutter, ALL CAPS names, a sex column, a stray admission number, and a
// signature line at the bottom.
const ROSTER = `
FORM 2A CLASS LIST 2026
S/N   NAME                    SEX
1.    ASHA JUMA MWANGI        F
2.    BARAKA PETER SHAYO      M
3)    NEEMA JOHN MASSAWE      F
4     JUMA HAMISI             M
5.    GRACE MOSHI  S0231
Total: 5
Signature: ..................
`;

test("roster line parser keeps every student and strips the furniture", () => {
  const rows = parseRosterLines(ROSTER);
  assert.deepEqual(
    rows.map((r) => r.name),
    ["Asha Juma Mwangi", "Baraka Peter Shayo", "Neema John Massawe", "Juma Hamisi", "Grace Moshi"],
  );
  assert.equal(rows[0]!.sex, "F");
  assert.equal(rows[1]!.sex, "M");
  assert.equal(rows[4]!.student_code, "S0231");
});

test("roster line parser drops headers, totals and signature lines", () => {
  const names = parseRosterLines(ROSTER).map((r) => r.name);
  for (const junk of ["Form 2a Class List 2026", "Total", "Signature", "Name"]) {
    assert.ok(!names.includes(junk), `${junk} should not be read as a student`);
  }
});

test("roster line parser never emits the same student twice", () => {
  const rows = parseRosterLines("1. ASHA JUMA\n2. ASHA JUMA\n3. BARAKA SHAYO");
  assert.equal(rows.length, 2);
});

test("subject sheet parser reads only subjects the school teaches", () => {
  const known = ["Physics", "Chemistry", "Biology", "History"];
  const rows = parseSubjectLines(
    [
      "1. ASHA JUMA MWANGI - Physics, Chemistry, Biology",
      "2. BARAKA SHAYO — History",
      "3. NEEMA MASSAWE - Further Mathematics",
    ].join("\n"),
    known,
  );
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0]!.subjects, ["Physics", "Chemistry", "Biology"]);
  assert.deepEqual(rows[1]!.subjects, ["History"]);
});

test("name matching survives a reordered surname but refuses a guess", () => {
  const people = [
    { id: 1, name: "Asha Juma Mwangi" },
    { id: 2, name: "Baraka Peter Shayo" },
  ];
  assert.equal(matchName("Asha Juma Mwangi", people)?.id, 1);
  assert.equal(matchName("MWANGI ASHA JUMA", people)?.id, 1);
  assert.equal(matchName("Asha", people), null);
  assert.equal(matchName("Someone Else Entirely", people), null);
});

test("name matching refuses an ambiguous reorder rather than picking one", () => {
  const twins = [
    { id: 1, name: "Juma Asha Mwangi" },
    { id: 2, name: "Asha Mwangi Juma" },
  ];
  // An exact match still wins, punctuation and spacing and all.
  assert.equal(matchName("Juma, Asha!  Mwangi", twins)?.id, 1);
  // But a third ordering is a reorder of BOTH rows: there is no defensible
  // answer, so the row goes back to the teacher instead of being guessed.
  assert.equal(matchName("Mwangi Juma Asha", twins), null);
});

test("titleCase normalises the shouted names printed on school sheets", () => {
  assert.equal(titleCase("ASHA JUMA MWANGI"), "Asha Juma Mwangi");
  assert.equal(titleCase("  neema   john  "), "Neema John");
});
