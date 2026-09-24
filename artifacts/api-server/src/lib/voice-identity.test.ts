// node --import tsx --test artifacts/api-server/src/lib/voice-identity.test.ts
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// voice-identity imports @workspace/db, which refuses to load without a
// DATABASE_URL. `pg.Pool` does not dial until the first query, so a dummy URL
// is enough to exercise the matching arithmetic with no database anywhere near
// the test.
process.env["DATABASE_URL"] ??= "postgres://test:test@127.0.0.1:5432/test";

type Identity = typeof import("./voice-identity");
let centroid: Identity["centroid"];
let cosine: Identity["cosine"];
let identify: Identity["identify"];
let normalise: Identity["normalise"];
let rank: Identity["rank"];

before(async () => {
  ({ centroid, cosine, identify, normalise, rank } =
    await import("./voice-identity"));
});

const here = dirname(fileURLToPath(import.meta.url));
const runtimeDir = resolve(here, "../../../../services/k9-runtime");

/** Deterministic pseudo-embeddings, matching the Python harness's generator. */
function voice(seed: number, width = 16, jitter = 0): number[] {
  const rand = (state: { s: number }) => {
    state.s = (state.s * 1103515245 + 12345) % 2147483648;
    return state.s / 2147483648;
  };
  const gauss = (state: { s: number }) =>
    Math.sqrt(-2 * Math.log(rand(state) || 1e-9)) *
    Math.cos(2 * Math.PI * rand(state));
  const state = { s: seed };
  let base = Array.from({ length: width }, () => gauss(state));
  if (jitter) {
    const noise = { s: seed * 7919 + 13 };
    base = base.map((value) => value + gauss(noise) * jitter);
  }
  return normalise(base);
}

test("cosine is bounded, symmetric, and survives a zero vector", () => {
  const a = voice(1);
  const b = voice(2);
  assert.ok(Math.abs(cosine(a, a) - 1) < 1e-9);
  assert.ok(Math.abs(cosine(a, b) - cosine(b, a)) < 1e-12);
  assert.ok(cosine(a, b) <= 1 && cosine(a, b) >= -1);
  assert.equal(cosine(a, new Array(16).fill(0)), 0);
  assert.ok(
    Math.abs(
      cosine(
        a,
        a.map((v) => -v),
      ) + 1,
    ) < 1e-9,
  );
});

test("cosine refuses a length mismatch rather than comparing nonsense", () => {
  assert.throws(() => cosine([1, 0], [1, 0, 0]), /length mismatch/);
});

test("a loud sample cannot drag the profile away from the quiet ones", () => {
  // Averaging after normalising is the whole point: a close-mic sample arrives
  // with a larger magnitude and must not outweigh three from the back row.
  const quiet = [voice(20), voice(20, 16, 0.1), voice(20, 16, 0.1)];
  const loud = voice(21).map((value) => value * 50);
  assert.ok(cosine(centroid([...quiet, loud]), quiet[0]!) > 0.5);
});

test("centroid refuses zero samples and ragged samples", () => {
  assert.throws(() => centroid([]), /zero samples/);
  assert.throws(
    () =>
      centroid([
        [1, 0],
        [1, 0, 0],
      ]),
    /inconsistent/,
  );
});

test("ties rank deterministically, not by roster insertion order", () => {
  const shared = voice(30);
  const first = new Map([
    ["STU-B", shared],
    ["STU-A", shared],
  ]);
  const second = new Map([
    ["STU-A", shared],
    ["STU-B", shared],
  ]);
  assert.deepEqual(
    rank(shared, first).map((c) => c.student_code),
    rank(shared, second).map((c) => c.student_code),
  );
});

test("the margin gate refuses two children who sound alike", () => {
  const twin = voice(50);
  const roster = new Map([
    ["STU-1", twin],
    ["STU-2", twin.map((v) => v + 0.02)],
  ]);
  const decision = identify(twin, roster, 0.5, 0.15);
  assert.ok(decision.top!.score > 0.9, "both should match strongly");
  assert.equal(decision.accepted, false);
  assert.equal(
    decision.student_code,
    null,
    "a near-tie must never name a child",
  );
});

test("the score gate refuses a speaker who is not in the room", () => {
  // A stranger's best match can still beat every rival, so the margin test
  // alone accepts them. Only the score gate catches this.
  const roster = new Map([
    ["STU-1", voice(60)],
    ["STU-2", voice(61)],
  ]);
  const stranger = voice(999);
  assert.equal(identify(stranger, roster, 0, 0.05).accepted, true);
  assert.equal(identify(stranger, roster, 0.75, 0.05).accepted, false);
});

test("an empty roster declines instead of throwing", () => {
  const decision = identify(voice(41), new Map(), 0, 0);
  assert.equal(decision.accepted, false);
  assert.equal(decision.student_code, null);
});

test("on a roster of one the margin is the score itself", () => {
  const profile = voice(40);
  const decision = identify(profile, new Map([["STU-1", profile]]), 0.5, 0.1);
  assert.equal(decision.runner_up, null);
  assert.ok(Math.abs(decision.margin - decision.top!.score) < 1e-9);
});

test("the live gate agrees with the harness that measures it", () => {
  // Two implementations of one rule is a divergence risk: the thresholds a
  // school ships are chosen by the Python harness, and applied by this file.
  // If they ever disagree, the number the school was given stops describing
  // what the classroom actually does. Same vectors, same answer, both sides.
  const cases = [
    { embedding: [1, 0, 0, 0], roster: { A: [1, 0, 0, 0], B: [0, 1, 0, 0] } },
    {
      embedding: [1, 0, 0, 0],
      roster: { A: [0.99, 0.1, 0, 0], B: [0.98, 0.14, 0, 0] },
    },
    { embedding: [0, 0, 1, 0], roster: { A: [1, 0, 0, 0], B: [0, 1, 0, 0] } },
    {
      embedding: [0.6, 0.6, 0.5, 0],
      roster: { A: [1, 0, 0, 0], B: [0, 1, 0, 0], C: [0, 0, 1, 0] },
    },
    { embedding: [1, 0, 0, 0], roster: { A: [1, 0, 0, 0] } },
  ];
  const script = `
import json, sys
sys.path.insert(0, ${JSON.stringify(runtimeDir)})
from speaker_harness import identify
out = []
for case in json.load(sys.stdin):
    d = identify(case["embedding"], case["roster"], 0.62, 0.12)
    out.append({
        "student_code": d.student_code,
        "accepted": d.accepted,
        "margin": round(d.margin, 9),
        "score": round(d.top.score, 9) if d.top else None,
    })
print(json.dumps(out))
`;
  const python = JSON.parse(
    execFileSync("python3", ["-c", script], {
      input: JSON.stringify(cases),
      encoding: "utf8",
    }),
  ) as {
    student_code: string | null;
    accepted: boolean;
    margin: number;
    score: number | null;
  }[];

  cases.forEach((testCase, index) => {
    const ours = identify(
      testCase.embedding,
      new Map(Object.entries(testCase.roster)),
      0.62,
      0.12,
    );
    const theirs = python[index]!;
    assert.equal(
      ours.student_code,
      theirs.student_code,
      `case ${index}: who was named`,
    );
    assert.equal(ours.accepted, theirs.accepted, `case ${index}: accepted`);
    assert.ok(
      Math.abs(ours.margin - theirs.margin) < 1e-9,
      `case ${index}: margin`,
    );
    assert.ok(
      Math.abs((ours.top?.score ?? 0) - (theirs.score ?? 0)) < 1e-9,
      `case ${index}: top score`,
    );
  });
});
