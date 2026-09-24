import { pool } from "@workspace/db";

// ===========================================================================
// Voice identity: enrolment, and deciding whether an utterance may be
// attributed to a named child.
//
// The matching arithmetic here is deliberately the same as
// services/k9-runtime/speaker_harness.py, which is what measures whether any
// of this is viable on a real class. Two implementations of one rule is a
// divergence risk, so voice-identity.test.ts pins both to the same fixtures —
// if the live gate and the measured gate ever disagree, the build fails.
//
// The split is: the Python runtime turns audio into embeddings (it holds
// TitaNet), and this owns the roster and the decision, because it holds the
// database. Audio never reaches this file.
// ===========================================================================

/**
 * Minimum cosine against the best-matching enrolled child.
 *
 * Catches a speaker who is not in the room at all — a visitor, a teacher, a
 * child who missed enrolment. Their nearest match can still beat every rival,
 * so the margin test alone would happily name them.
 */
export const DEFAULT_MIN_SCORE = 0.62;

/**
 * Minimum gap between the best and second-best match.
 *
 * Catches two children who genuinely sound alike — the common case in a class
 * of forty same-age voices. Both score highly and the winner is close to a coin
 * toss, which is exactly the case that must not be written to a profile.
 *
 * Both defaults are starting points, not findings. The school's real numbers
 * come from running the harness on that school's own enrolled class; see
 * docs/K9_VOICE_IDENTITY.md.
 */
export const DEFAULT_MIN_MARGIN = 0.12;

export type Vector = number[];

export function cosine(a: Vector, b: Vector): number {
  if (a.length !== b.length)
    throw new Error(`embedding length mismatch: ${a.length} vs ${b.length}`);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  if (normA === 0 || normB === 0) return 0;
  return Math.max(-1, Math.min(1, dot / (Math.sqrt(normA) * Math.sqrt(normB))));
}

export function normalise(vector: Vector): Vector {
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (norm === 0) return vector.map(() => 0);
  return vector.map((value) => value / norm);
}

/**
 * The enrolled profile: mean of per-sample embeddings, re-normalised.
 *
 * Each sample is normalised *before* averaging so one loud close-mic recording
 * cannot outweigh three quiet ones. This is why enrolment takes several
 * utterances: a child's voice moves with distance, illness, emotion and mic
 * position, and a centroid built from one close sentence matches nothing said
 * from the back of the room.
 */
export function centroid(vectors: Vector[]): Vector {
  if (vectors.length === 0)
    throw new Error("cannot build a voice profile from zero samples");
  const width = vectors[0]!.length;
  if (vectors.some((vector) => vector.length !== width))
    throw new Error("enrolment samples have inconsistent embedding length");
  const unit = vectors.map(normalise);
  const mean = new Array<number>(width).fill(0);
  for (const vector of unit)
    for (let i = 0; i < width; i += 1) mean[i]! += vector[i]! / unit.length;
  return normalise(mean);
}

export type Candidate = { student_code: string; score: number };

export type Identification = {
  top: Candidate | null;
  runner_up: Candidate | null;
  accepted: boolean;
  margin: number;
  /** Null whenever the gates refused — never a best guess. */
  student_code: string | null;
};

export function rank(
  embedding: Vector,
  roster: Map<string, Vector>,
): Candidate[] {
  const scored = [...roster].map(([student_code, profile]) => ({
    student_code,
    score: cosine(embedding, profile),
  }));
  // Sort by score then by code, so a tie resolves the same way every time
  // rather than depending on the order rows came back from Postgres.
  scored.sort(
    (a, b) => b.score - a.score || a.student_code.localeCompare(b.student_code),
  );
  return scored;
}

export function identify(
  embedding: Vector,
  roster: Map<string, Vector>,
  minScore = DEFAULT_MIN_SCORE,
  minMargin = DEFAULT_MIN_MARGIN,
): Identification {
  const ranked = rank(embedding, roster);
  if (ranked.length === 0)
    return {
      top: null,
      runner_up: null,
      accepted: false,
      margin: 0,
      student_code: null,
    };
  const top = ranked[0]!;
  const runnerUp = ranked[1] ?? null;
  // On a roster of one there is nothing to be confused with, so the margin is
  // the score itself and only the score gate is doing work.
  const margin = runnerUp ? top.score - runnerUp.score : top.score;
  const accepted = top.score >= minScore && margin >= minMargin;
  return {
    top,
    runner_up: runnerUp,
    accepted,
    margin,
    student_code: accepted ? top.student_code : null,
  };
}

/**
 * The enrolled voices for one class.
 *
 * Scoped to the class in the room, never the whole school: every extra enrolled
 * voice is another chance at a closer false match, and the timetable already
 * says who is meant to be here. Expired and deactivated profiles are excluded
 * in the query rather than filtered afterwards, so there is no path where a
 * profile past its retention date takes part in a decision.
 */
export async function rosterFor(
  classId: number,
  model: string,
): Promise<Map<string, Vector>> {
  const { rows } = await pool.query(
    `SELECT student_code, embedding
       FROM voice_profiles
      WHERE class_id = $1
        AND model = $2
        AND active = true
        AND expires_at > now()`,
    [classId, model],
  );
  return new Map(
    rows.map((row) => [row.student_code as string, row.embedding as Vector]),
  );
}

export type EnrollmentInput = {
  studentId: number;
  studentCode: string;
  classId: number | null;
  samples: { embedding: Vector; seconds?: number; prompt?: string }[];
  model: string;
  modelRevision: string;
  consentReference: string;
  consentBy: string;
  enrolledBy: number | null;
  retentionDays: number;
};

/** A profile built from one or two utterances is not worth having. */
export const MIN_SAMPLES = 3;

export async function recordAudit(
  studentCode: string,
  action: string,
  actorId: number | null,
  actorRole: string | null,
  detail: string | null,
): Promise<void> {
  await pool.query(
    `INSERT INTO voice_audit (student_code, action, actor_id, actor_role, detail)
     VALUES ($1, $2, $3, $4, $5)`,
    [studentCode, action, actorId, actorRole, detail],
  );
}

/**
 * Enrol or re-enrol a child, in one transaction.
 *
 * Re-enrolment replaces: two centroids for one child would make identification
 * depend on which row was read first. The samples are stored as vectors so the
 * profile can be rebuilt, or an outlier dropped, without asking a child to
 * record again — and so that no audio has to be kept to make that possible.
 */
export async function enroll(input: EnrollmentInput): Promise<{
  profileId: number;
  dims: number;
  sampleCount: number;
  /** Cosine of each sample against the final centroid, lowest first. */
  agreement: number[];
  replaced: boolean;
}> {
  if (input.samples.length < MIN_SAMPLES)
    throw new Error(`voice enrolment needs at least ${MIN_SAMPLES} samples`);
  const vectors = input.samples.map((sample) => sample.embedding);
  const profile = centroid(vectors);
  const agreement = vectors
    .map((vector) => cosine(vector, profile))
    .sort((a, b) => a - b);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query(
      `SELECT id FROM voice_profiles WHERE student_id = $1 AND model = $2`,
      [input.studentId, input.model],
    );
    const replaced = existing.rowCount ? existing.rowCount > 0 : false;
    if (replaced)
      await client.query(`DELETE FROM voice_profiles WHERE id = $1`, [
        existing.rows[0]!.id,
      ]);
    const inserted = await client.query(
      `INSERT INTO voice_profiles
         (student_id, student_code, class_id, embedding, dims, sample_count, model,
          model_revision, consent_reference, consent_recorded_at, consent_by,
          enrolled_by, expires_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, now(), $10, $11,
               now() + ($12 || ' days')::interval)
       RETURNING id`,
      [
        input.studentId,
        input.studentCode,
        input.classId,
        JSON.stringify(profile),
        profile.length,
        vectors.length,
        input.model,
        input.modelRevision,
        input.consentReference,
        input.consentBy,
        input.enrolledBy,
        String(input.retentionDays),
      ],
    );
    const profileId = inserted.rows[0]!.id as number;
    for (let i = 0; i < input.samples.length; i += 1) {
      const sample = input.samples[i]!;
      await client.query(
        `INSERT INTO voice_enrollment_samples (profile_id, embedding, seconds, agreement, prompt)
         VALUES ($1, $2::jsonb, $3, $4, $5)`,
        [
          profileId,
          JSON.stringify(normalise(sample.embedding)),
          sample.seconds ?? null,
          Math.round(cosine(sample.embedding, profile) * 100),
          sample.prompt ?? null,
        ],
      );
    }
    await client.query(
      `INSERT INTO voice_audit (student_code, action, actor_id, actor_role, detail)
       VALUES ($1, $2, $3, 'staff', $4)`,
      [
        input.studentCode,
        replaced ? "re_enrolled" : "enrolled",
        input.enrolledBy,
        `${vectors.length} samples, ${input.model}@${input.modelRevision}, retention ${input.retentionDays}d`,
      ],
    );
    await client.query("COMMIT");
    return {
      profileId,
      dims: profile.length,
      sampleCount: vectors.length,
      agreement,
      replaced,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Delete profiles past their retention date.
 *
 * Retention is set at enrolment and enforced here rather than being a policy
 * someone remembers. The audit row outlives the profile, because a deletion is
 * the entry a parent is most entitled to see.
 */
export async function sweepExpired(): Promise<number> {
  const { rows } = await pool.query(
    `DELETE FROM voice_profiles WHERE expires_at <= now() RETURNING student_code`,
  );
  for (const row of rows)
    await recordAudit(
      row.student_code as string,
      "expired",
      null,
      "system",
      "retention sweep",
    );
  return rows.length;
}
