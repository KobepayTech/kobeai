// node --import tsx --test artifacts/api-server/src/lib/market-agent.test.ts
import assert from "node:assert/strict";
import { before, test } from "node:test";
import type { MarketAgentSettings } from "@workspace/db";

// market-agent pulls in @workspace/db, which refuses to load without a
// DATABASE_URL. `pg.Pool` does not dial until the first query, so a dummy
// URL is enough to import the module and exercise its pure planning,
// pricing and validation logic without a database anywhere near the test.
process.env["DATABASE_URL"] ??= "postgres://test:test@127.0.0.1:5432/test";

type Agent = typeof import("./market-agent");
let agent: Agent;

before(async () => {
  agent = await import("./market-agent");
});

const SETTINGS: MarketAgentSettings = {
  id: 1,
  enabled: true,
  floor_per_subject: 6,
  max_open_questions: 120,
  cycle_minutes: 15,
  stale_hours: 48,
  reward_min: 50,
  reward_max: 1500,
  human_review: false,
  subjects: [],
  updated_at: new Date(),
};

const emptyFloor = () => ({
  open: new Map<string, number>(),
  won24h: new Map<string, number>(),
  totalOpen: 0,
  weakTopics: [] as string[],
  rosterSubjects: [] as string[],
});

test("the agent stocks the subjects the roster actually takes", () => {
  const floor = { ...emptyFloor(), rosterSubjects: ["Physics", "History"] };
  assert.deepEqual(agent.chooseSubjects(SETTINGS, floor), ["Physics", "History"]);
});

test("an operator subject list overrides the roster", () => {
  const floor = { ...emptyFloor(), rosterSubjects: ["Physics"] };
  const settings = { ...SETTINGS, subjects: ["Mathematics", "Mathematics", "Biology"] };
  assert.deepEqual(agent.chooseSubjects(settings, floor), ["Mathematics", "Biology"]);
});

test("a school on day one still gets a default shelf", () => {
  assert.ok(agent.chooseSubjects(SETTINGS, emptyFloor()).includes("Mathematics"));
});

test("planning stops at the open-floor ceiling", () => {
  const floor = { ...emptyFloor(), totalOpen: 120 };
  assert.deepEqual(agent.planMarket(SETTINGS, floor), []);
});

test("planning asks for nothing when every subject is stocked", () => {
  const floor = emptyFloor();
  floor.rosterSubjects = ["Physics"];
  floor.open.set("Physics", 6);
  floor.totalOpen = 6;
  assert.deepEqual(agent.planMarket(SETTINGS, floor), []);
});

test("planning refills the thinnest subject and stays inside the ceiling", () => {
  const floor = emptyFloor();
  floor.rosterSubjects = ["Physics", "Biology"];
  floor.open.set("Physics", 1);
  floor.open.set("Biology", 6);
  floor.totalOpen = 7;
  const plan = agent.planMarket(SETTINGS, floor);
  assert.ok(plan.length > 0);
  assert.ok(plan.every((p) => p.subject === "Physics"));
  assert.equal(
    plan.reduce((n, p) => n + p.count, 0),
    5,
  );
});

test("a subject students are clearing gets a deeper shelf", () => {
  const floor = emptyFloor();
  floor.rosterSubjects = ["Physics"];
  floor.open.set("Physics", 6);
  floor.won24h.set("Physics", 8); // 8 won today → target 6 + 4 = 10
  floor.totalOpen = 6;
  const wanted = agent.planMarket(SETTINGS, floor).reduce((n, p) => n + p.count, 0);
  assert.equal(wanted, 4);
});

test("planning never exceeds the remaining headroom", () => {
  const floor = emptyFloor();
  floor.rosterSubjects = ["Physics", "Biology", "Chemistry"];
  floor.totalOpen = 118; // only 2 slots left under max_open_questions
  const wanted = agent.planMarket(SETTINGS, floor).reduce((n, p) => n + p.count, 0);
  assert.equal(wanted, 2);
});

test("weak topics are only attributed to a subject they plausibly belong to", () => {
  const weak = ["Newton's laws of motion", "quadratic equations", "the Maji Maji resistance"];
  assert.deepEqual(agent.weakTopicsForSubject("Physics", weak), ["Newton's laws of motion"]);
  assert.deepEqual(agent.weakTopicsForSubject("Mathematics", weak), ["quadratic equations"]);
  assert.deepEqual(agent.weakTopicsForSubject("Biology", weak), []);
});

test("a weak topic drives the plan when there is one, curriculum rotation otherwise", () => {
  const floor = emptyFloor();
  floor.rosterSubjects = ["Physics"];
  floor.weakTopics = ["Newton's laws of motion"];
  const [item] = agent.planMarket(SETTINGS, floor);
  assert.equal(item!.topic, "Newton's laws of motion");
  assert.match(item!.reason, /weak/);

  const blind = agent.planMarket(SETTINGS, { ...emptyFloor(), rosterSubjects: ["Physics"] });
  assert.match(blind[0]!.reason, /rotation/);
});

test("pricing stays inside the operator's band and rewards difficulty", () => {
  const easy = agent.priceQuestion("easy", 6, 6, SETTINGS);
  const medium = agent.priceQuestion("medium", 6, 6, SETTINGS);
  const hard = agent.priceQuestion("hard", 6, 6, SETTINGS);
  assert.ok(easy < medium && medium < hard);
  for (const kp of [easy, medium, hard]) {
    assert.ok(kp >= SETTINGS.reward_min && kp <= SETTINGS.reward_max, `${kp} out of band`);
  }
});

test("a starved subject pays more than a stocked one", () => {
  const stocked = agent.priceQuestion("medium", 6, 6, SETTINGS);
  const starved = agent.priceQuestion("medium", 0, 6, SETTINGS);
  assert.ok(starved > stocked);
  assert.ok(starved <= SETTINGS.reward_max);
});

test("pricing clamps to the band even when it is a single value", () => {
  const flat = { reward_min: 100, reward_max: 100 };
  assert.equal(agent.priceQuestion("hard", 0, 6, flat), 100);
});

test("a draft with a broken answer key is thrown away", () => {
  const drafts = agent.sanitizeDrafts([
    { prompt: "What is the SI unit of force?", choices: ["Newton", "Joule", "Watt", "Pascal"], correct_index: 0 },
    { prompt: "Too short", choices: ["a", "b"], correct_index: 0 },
    { prompt: "Index points past the end of the choices", choices: ["a", "b"], correct_index: 5 },
    { prompt: "A question with no choices at all here", choices: [], correct_index: 0 },
    { prompt: "Which of these is correct about gravity?", choices: ["All of the above", "b", "c"], correct_index: 1 },
    { prompt: "Two options say exactly the same thing here", choices: ["Newton", "newton", "Joule"], correct_index: 0 },
  ]);
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0]!.correct_index, 0);
});

test("draft sanitising survives anything the model hands back", () => {
  assert.deepEqual(agent.sanitizeDrafts(null), []);
  assert.deepEqual(agent.sanitizeDrafts("not an array"), []);
  assert.deepEqual(agent.sanitizeDrafts([null, 42, {}]), []);
});

test("fingerprints ignore formatting so the same question is never posted twice", () => {
  const a = agent.fingerprint("Physics", "What is the SI unit of force?");
  const b = agent.fingerprint("Physics", "  what is   the SI unit of FORCE ?  ");
  const c = agent.fingerprint("Chemistry", "What is the SI unit of force?");
  assert.equal(a, b);
  assert.notEqual(a, c);
});
