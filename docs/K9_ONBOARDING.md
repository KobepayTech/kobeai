# Onboarding a school

Status: adopted • Owner: KobeAI school-server team • Last updated: 2026-09-12

Getting a Tanzanian secondary school onto K9 used to mean somebody sitting at
a keyboard for two days: type 600 student names, type the staff list, work out
who takes which subjects, photograph 600 faces one profile page at a time.

Nobody types a list any more. The school already runs on paper — the class
list comes out of the office printed, the Form 3 subject options come back as
a ruled sheet the students signed — and reading paper is exactly what a vision
model is for.

```
 install wizard         the head of school, once, in a browser
      │
      ▼
 teacher QR codes       printed, pinned in the staff room
      │
      ▼  teacher scans with their own phone
 ┌──────────────────────────────────────────────┐
 │ 1. who you are      form → account created   │
 │ 2. class list       photo → check → commit   │
 │ 3. the faces        name → shutter → next    │
 │ 4. subject options  photo → check → commit   │
 └──────────────────────────────────────────────┘
```

Every read is a **proposal**. `commit` is the only thing that writes students.

## 1. Install: the school, and only the school

A K9 server ships with no accounts. Whoever opens the Teacher Dashboard first
is sent to `/setup` and asked for two things:

- the **school's name**, which becomes the tenant and the name in the sidebar;
- a **setup password**, which is not a login — it is the break-glass
  credential for changing this server's setup later, and the second factor on
  the operator unlock below.

…and then the school **administrator**'s name, email and password. The licence
key is shown once, to be written down and kept with the server.

`POST /v1/setup/school` always creates role `admin`. It is refused the moment
a setup row or any admin account exists, so re-running install on a live
school server is not a free account.

### Where the operator console went

`/central/v1/admin/*` — every school's licence key, the KP economy, the market
agent's reward band — belongs to KobepayTech, not to the school the server is
sitting in. So:

- the install flow has **no path** to `super_admin`;
- `POST /v1/setup/operator/unlock` needs the server to have been started with
  `K9_OPERATOR_SECRET` **and** the caller to present both that secret and the
  school's setup password — a leaked environment file is not enough, and
  neither is standing at the school's keyboard;
- without the environment variable that route answers **404**, identical to a
  route that was never mounted, so a school install has no operator surface to
  find, probe or brute-force;
- the dashboard builds its navigation from `GET /v1/me/capabilities`, so a
  school administrator never learns those pages exist and a teacher stops
  seeing "Central Admin" taunting them with a 403.

The nav hiding is the courtesy. `requireAuth(["super_admin"])` on the central
router is the enforcement, and no amount of poking at the dashboard changes
it.

The ISO installer and the Windows desktop build follow the same rule: the ISO
prints a *suggested setup password* and sends the installer to the wizard, and
the desktop build's `bootstrapK9School` creates an `admin` and records the
same `school_setup` row.

## 2. Teacher QR codes

From **Staff & Students** the administrator creates a code — optionally
labelled ("Form 2 staff room"), valid for a chosen window, usable once or a
set number of times — and prints it. The token is shown once; only its
SHA-256 hash is stored, the same rule the parent claim codes follow.

The QR resolves to `/lens/#/onboard/<token>` — the Lens PWA, already served by
the school server, so there is no app store and no internet.

## 3. What the teacher fills in

Scanning opens a form, not a login:

| Field | Why K9 asks |
|---|---|
| Full name | Identity |
| **What should K9 call you?** | The nickname it says out loud in every briefing |
| Email + password | Their sign-in from then on |
| Age band | Pitches how it explains things |
| Teaching style | Worked examples / drill / discussion / visual — feeds lesson plans |
| Language | Kiswahili or English, for whispers and briefings |
| Briefing length | One line, a few lines, or everything it has |
| Subjects and classes | What it shows them by default |

Submitting mints the account and returns a signed token, which the page stores
under the Lens's own key. The teacher goes from scanning a QR to photographing
their class list without ever seeing a login screen.

Subject and class choices are offered as chips built from what the school
already has, so the second teacher taps where the first one typed.

## 4. Reading the class list

The teacher photographs the printed list. The server:

1. sends the photo to the on-prem vision model
   (`runtime.ollama.vision_model`, Qwen3-VL by default), falling back to the
   K9 runtime's own `/v1/ocr`;
2. asks the brain to structure the text into rows, in strict JSON;
3. **also** runs a plain regex line parser, and keeps the regex rows if the
   model returned fewer — a silently dropped student is the one failure mode a
   teacher will not catch;
4. returns the rows with a per-row confidence. Anything under 70 is flagged
   for a second look.

The line parser handles what school sheets actually look like: an "S/N"
gutter, ALL CAPS names, a trailing admission number, a lone M/F column, header
bands, totals and signature lines.

The teacher edits or deletes rows, names the class, and commits. Commit
matches each name against students the school already has — exactly, then by
the same words in a different order (sheets print SURNAME First as often as
First SURNAME) — so re-photographing a sheet enrols students into the class
rather than forking them and orphaning their history and their enrolled face.
An ambiguous reorder is never guessed at.

**No camera, or no vision model on the server?**
`POST /v1/onboarding/papers/text` takes the list as typed or pasted text
through the identical parsers. A school with no GPU box still gets onboarded.

## 5. The face walk

Camera presence is the whole point of K9, and it needs a photo of every
student. Doing that from a desktop, one profile page at a time, is where
onboarding used to die.

Instead K9 shows the teacher **one name at a time** from the students who have
no enrolled photo. The teacher calls that student over, taps the shutter, and
the phone posts the frame to `POST /v1/faces/students/:studentCode`, which
extracts the SFace embedding through the K9 runtime. Absent student? Skip;
they come back to the top of the queue next time.

A class in a period.

## 6. Subject options

From Form 3 the school splits into science and arts streams, so "everyone sits
every paper" is wrong. The signed subject-option sheet gets the same
photo-read-check-commit treatment, into `student_subjects`.

Only subjects the school actually teaches survive the read — a model that
invents "Further Mathematics" for a school that does not offer it must not
create a subject out of thin air — and a name the reader cannot match to a
student is **reported back**, not guessed at. The wrong student dropped from
Physics is a term of wrong lessons.

Downstream, `student_subjects` is what stops the question-market agent
quizzing a student on a paper they dropped two years ago, and what tells the
agent which subjects this school stocks at all.

## Endpoints

| Method | Path | Who |
|---|---|---|
| `GET` | `/v1/setup/state` | public |
| `POST` | `/v1/setup/school` | public, once |
| `POST` | `/v1/setup/operator/unlock` | operator secret + setup password |
| `GET` | `/v1/setup/school` | admin |
| `GET` | `/v1/me/capabilities` | any signed-in user |
| `POST` | `/v1/onboarding/invites` | admin |
| `GET` | `/v1/onboarding/invites` | admin |
| `POST` | `/v1/onboarding/invites/:id/revoke` | admin |
| `GET` | `/v1/onboarding/invites/:token/form` | public (the QR) |
| `POST` | `/v1/onboarding/invites/:token/claim` | public (the QR) |
| `GET`/`PATCH` | `/v1/onboarding/me` | staff |
| `POST` | `/v1/onboarding/papers` | staff (image body) |
| `POST` | `/v1/onboarding/papers/text` | staff |
| `GET`/`PATCH` | `/v1/onboarding/papers/:id` | staff |
| `POST` | `/v1/onboarding/papers/:id/commit` | staff |
| `GET` | `/v1/onboarding/face-queue` | staff |
| `GET` | `/v1/onboarding/subjects` | staff |
| `POST` | `/v1/onboarding/students/:id/subjects` | staff |
| `GET` | `/v1/onboarding/classes` | staff |

Claim endpoints are unauthenticated by design — the QR token **is** the
credential — so they are throttled like a login surface, and the claim
re-checks the use count inside the transaction: two teachers scanning the same
single-use code at the same moment must not both get an account.

## Schema

| Table | What it holds |
|---|---|
| `school_setup` | Singleton: school name, setup password hash, tenant, completion |
| `teacher_invites` | QR token hashes, label, role, uses, expiry, revocation |
| `staff_profiles` | The personalisation from the QR form, and where the teacher is in the walk |
| `paper_imports` | One row per photographed sheet: raw text, the parsed proposal, what was committed |
| `student_subjects` | Who takes what, with source and confidence |

## Tests

`artifacts/api-server/src/lib/paper-reader.test.ts` covers the parsers against
a class list shaped like a real one — header band, S/N gutter, shouted names,
a sex column, a stray admission number, a signature line — plus subject
reading, name matching, and the refusal to guess an ambiguous reorder.
