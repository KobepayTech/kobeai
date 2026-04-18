// Idempotent seed: one demo developer ("KobeAI Studios") + a few approved
// mini-apps in different categories so the watch-app store and the
// teacher-dashboard moderation queue have real data to render.
//
// Re-runs are safe: each insert checks for an existing row first.

import { eq, and } from "drizzle-orm";
import bcrypt from "bcryptjs";
import {
  db,
  developersTable,
  miniAppsTable,
  miniAppVersionsTable,
} from "@workspace/db";

type SeedApp = {
  slug: string;
  name: string;
  description: string;
  icon: string;
  category: string;
  type: "flashcards" | "quiz" | "reading" | "counter" | "timer";
  price_kp: number;
  price_tsh: number;
  status: "approved" | "submitted";
  manifest: Record<string, unknown>;
};

const APPS: SeedApp[] = [
  {
    slug: "swahili-flashcards",
    name: "Swahili Flashcards",
    description: "Learn 50 essential Swahili words with flip-card practice.",
    icon: "🗣️",
    category: "languages",
    type: "flashcards",
    price_kp: 0,
    price_tsh: 0,
    status: "approved",
    manifest: {
      type: "flashcards",
      kp_reward_per_completion: 5,
      cards: [
        { front: "Hello", back: "Habari" },
        { front: "Thank you", back: "Asante" },
        { front: "Goodbye", back: "Kwaheri" },
        { front: "Water", back: "Maji" },
        { front: "Food", back: "Chakula" },
        { front: "School", back: "Shule" },
        { front: "Teacher", back: "Mwalimu" },
        { front: "Book", back: "Kitabu" },
        { front: "Friend", back: "Rafiki" },
        { front: "Sun", back: "Jua" },
      ],
    },
  },
  {
    slug: "math-quick-quiz",
    name: "Math Quick Quiz",
    description: "10 timed multiplication questions. Beat your high score.",
    icon: "🧮",
    category: "math",
    type: "quiz",
    price_kp: 0,
    price_tsh: 0,
    status: "approved",
    manifest: {
      type: "quiz",
      kp_reward_per_completion: 10,
      time_per_question_sec: 15,
      questions: [
        { q: "7 × 8 = ?", choices: ["54", "56", "63", "48"], answer: 1 },
        { q: "9 × 6 = ?", choices: ["54", "56", "63", "48"], answer: 0 },
        { q: "12 × 4 = ?", choices: ["44", "48", "52", "56"], answer: 1 },
        { q: "11 × 11 = ?", choices: ["111", "121", "131", "144"], answer: 1 },
        { q: "15 × 3 = ?", choices: ["35", "40", "45", "50"], answer: 2 },
      ],
    },
  },
  {
    slug: "morning-reflection",
    name: "Morning Reflection",
    description: "A short Swahili passage to read each morning before class.",
    icon: "📖",
    category: "wellness",
    type: "reading",
    price_kp: 0,
    price_tsh: 0,
    status: "approved",
    manifest: {
      type: "reading",
      kp_reward_per_completion: 3,
      pages: [
        {
          title: "Asubuhi Njema",
          body: "Asubuhi ni wakati mzuri wa kuanza siku. Pumua kwa kina mara tatu na kumbuka jambo moja unaloshukuru leo.",
        },
        {
          title: "Lengo la Leo",
          body: "Andika lengo moja dogo unalotaka kufanikisha leo shuleni. Lifanye liwe wazi na rahisi kupima.",
        },
      ],
    },
  },
  {
    slug: "water-counter",
    name: "Water Counter",
    description: "Tap each time you drink water. Hit 8 cups for the day.",
    icon: "💧",
    category: "wellness",
    type: "counter",
    price_kp: 0,
    price_tsh: 0,
    status: "approved",
    manifest: {
      type: "counter",
      kp_reward_per_completion: 2,
      target: 8,
      unit: "cups",
      label: "Cups of water today",
    },
  },
  {
    slug: "focus-timer-25",
    name: "Focus Timer 25",
    description: "Pomodoro-style 25 minute focus block with quiet alert.",
    icon: "⏱️",
    category: "wellness",
    type: "timer",
    price_kp: 0,
    price_tsh: 0,
    status: "approved",
    manifest: {
      type: "timer",
      kp_reward_per_completion: 5,
      duration_sec: 1500,
      label: "Focus",
    },
  },
  {
    slug: "history-tz-flashcards",
    name: "Tanzania History",
    description: "20 key dates and figures from Tanzanian history. Premium.",
    icon: "🇹🇿",
    category: "history",
    type: "flashcards",
    price_kp: 25,
    price_tsh: 0,
    status: "approved",
    manifest: {
      type: "flashcards",
      kp_reward_per_completion: 0,
      cards: [
        { front: "Year of Independence", back: "1961" },
        { front: "First President", back: "Julius Nyerere" },
        { front: "Union with Zanzibar", back: "26 April 1964" },
        { front: "Capital City", back: "Dodoma (since 1996)" },
        { front: "National Language", back: "Swahili" },
      ],
    },
  },
  {
    slug: "science-pop-quiz",
    name: "Science Pop Quiz",
    description: "Awaiting review — 5 mixed science questions.",
    icon: "🔬",
    category: "science",
    type: "quiz",
    price_kp: 0,
    price_tsh: 0,
    status: "submitted",
    manifest: {
      type: "quiz",
      kp_reward_per_completion: 8,
      time_per_question_sec: 20,
      questions: [
        { q: "Water boils at?", choices: ["50°C", "100°C", "150°C", "200°C"], answer: 1 },
        { q: "Plants make food via?", choices: ["Respiration", "Digestion", "Photosynthesis", "Osmosis"], answer: 2 },
      ],
    },
  },
];

export async function seedMiniApps(): Promise<void> {
  // --- demo developer ----------------------------------------------------
  let dev = (
    await db
      .select()
      .from(developersTable)
      .where(eq(developersTable.email, "studio@kobeai.dev"))
  )[0];
  const seededHash = await bcrypt.hash("studio12345", 10);
  if (dev) {
    // Always heal the password hash so prior seeds (sha256) get upgraded
    // to bcrypt and remain testable with the documented demo creds.
    await db
      .update(developersTable)
      .set({ password_hash: seededHash })
      .where(eq(developersTable.id, dev.id));
  } else {
    [dev] = await db
      .insert(developersTable)
      .values({
        email: "studio@kobeai.dev",
        display_name: "KobeAI Studios",
        password_hash: await bcrypt.hash("studio12345", 10),
        bio: "Official first-party mini-app studio.",
        website: "https://kobeai.dev",
        plan: "studio",
        plan_status: "active",
        plan_expires_at: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
        payout_method: "mpesa",
        payout_account: "+255700000000",
      })
      .returning();
  }
  if (!dev) return; // safety

  // --- mini apps ---------------------------------------------------------
  for (const a of APPS) {
    const existing = (
      await db
        .select()
        .from(miniAppsTable)
        .where(
          and(
            eq(miniAppsTable.developer_id, dev.id),
            eq(miniAppsTable.slug, a.slug),
          ),
        )
    )[0];
    if (existing) continue;

    const [app] = await db
      .insert(miniAppsTable)
      .values({
        developer_id: dev.id,
        slug: a.slug,
        name: a.name,
        description: a.description,
        icon: a.icon,
        category: a.category,
        type: a.type,
        price_kp: a.price_kp,
        price_tsh: a.price_tsh,
        status: a.status,
      })
      .returning();
    if (!app) continue;

    const [version] = await db
      .insert(miniAppVersionsTable)
      .values({
        app_id: app.id,
        version: 1,
        manifest: a.manifest,
        status: a.status === "approved" ? "approved" : "submitted",
      })
      .returning();
    if (!version) continue;

    await db
      .update(miniAppsTable)
      .set({ current_version_id: version.id })
      .where(eq(miniAppsTable.id, app.id));
  }
}
