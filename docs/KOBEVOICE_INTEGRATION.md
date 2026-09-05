# KobeVoice integration for KobeAI

KobeVoice is included in this repository as a Git submodule at `services/kobevoice`.

Pinned upstream source:

- Repository: `KobepayTech/kobevoice`
- Branch: `claude/pipecat-integration-83g5ih`
- Commit: `852f8d06ad6d46eb4d2ac92916d23ff1b605cf3b`

The upstream `main` branch currently contains only a minimal README, so KobeAI pins the latest functional voice-platform branch rather than the empty main branch.

Clone KobeAI with its voice service:

```bash
git clone --recurse-submodules https://github.com/KobepayTech/kobeai.git
cd kobeai
```

For an existing checkout:

```bash
git submodule update --init --recursive
```

## What KobeVoice adds

KobeVoice is a real-time voice-agent/call-center stack built around LiveKit Agents. Its functional branch includes:

- FastAPI control plane and PostgreSQL-backed tenancy/call data.
- LiveKit voice-agent worker.
- SIP-oriented telephony tooling for future inbound/outbound calls.
- Whisper-based local speech-to-text option.
- Ollama/Qwen local LLM option.
- Chatterbox local text-to-speech, including multilingual/Swahili support in the selected checkpoint.
- Voice activity / turn handling.
- Compliance gates, do-not-call and consent records for outbound calling.
- A Next.js supervisor dashboard foundation.
- Local/self-hosted deployment through Docker Compose.

KobeVoice should be the **voice/media layer** for KobeAI, not a second AI brain or a second school database.

## Target architecture

```text
Wear OS / classroom microphone / phone / browser / school reception
                            |
                            v
                    LiveKit / KobeVoice
                            |
                    speech-to-text (STT)
                            |
                            v
                       KobeAI Router
          +-----------------+------------------+
          |                 |                  |
    deterministic          LLM              agent/tool
       school API           |                  |
                            v                  v
                           PAIR           CubeSandbox
                            |                  |
                     Ollama nodes       isolated tools
                            |
                            v
                      response text
                            |
                            v
                    KobeVoice TTS
                            |
                            v
             speaker / earbuds / phone call
```

The responsibilities stay separated:

- **KobeVoice**: microphone/audio transport, LiveKit rooms, SIP/telephony, STT, TTS, call state and human transfer.
- **KobeAI Router**: intent classification, model selection, school context, safety policy, retrieval, caching and tool selection.
- **NVIDIA PAIR**: choose which trusted local machine runs an eligible LLM inference request.
- **CubeSandbox**: isolated execution environment for agent code/tools.
- **KobeAI API/database**: source of truth for students, classes, attendance, quizzes, timetables, documents, parent settings and school permissions.

Do not duplicate student/class records inside KobeVoice. The voice agent should use scoped KobeAI APIs/tools.

## Highest-value KobeAI uses

### 1. Spoken AI tutor on the watch

Student speaks -> KobeVoice/LiveKit receives audio -> STT -> KobeAI Router -> answer -> KobeVoice TTS -> spoken answer through watch/earbuds.

This removes the need for keyboard-first interaction and makes Swahili/English conversation a first-class interface.

### 2. Classroom AI through microphones, TV and speakers

A classroom computer can join a persistent LiveKit room. The room microphone feeds KobeVoice, the transcript goes to KobeAI, and the response is spoken over the classroom speakers while text/cards can appear on the TV.

Use explicit wake-word/push-to-talk/teacher-controlled listening modes. Do not treat every classroom conversation as an instruction by default.

### 3. School AI receptionist

KobeVoice can become the voice front end for reception:

- school hours and directions;
- fee/payment questions;
- timetable and event information;
- visitor routing;
- basic parent/student support;
- transfer to a human when confidence is low or the caller asks for staff.

The receptionist gets answers from KobeAI tools and school data rather than maintaining a separate knowledge database.

### 4. Parent phone calls

With a SIP trunk or GSM/SIP gateway, KobeVoice can let KobeAI call parents for approved workflows such as:

- absence follow-up;
- emergency/closure announcements;
- payment reminders;
- meeting reminders;
- requested teacher callbacks;
- unanswered information requests from approved school workflows.

Outbound calling must be permissioned, logged and rate-limited. Local Tanzanian telecom/privacy requirements must be configured rather than blindly using the branch's current US-style calling-hour defaults.

### 5. Teacher voice assistant

Teachers can speak commands such as:

- "Mark Asha absent today."
- "Create a five-question Form Two biology quiz."
- "Print this worksheet for Form One."
- "What class do I have next?"
- "Summarize today's unanswered student questions."

KobeVoice handles the speech session; KobeAI executes the authenticated school action.

### 6. Accessibility and low-device classrooms

Voice makes KobeAI useful when students do not have phones/computers. A classroom can use one computer, one TV, microphones and speakers while KobeAI remains available to the whole room.

## Integration contract to implement

KobeVoice should call a dedicated authenticated KobeAI voice gateway instead of directly calling its own LLM for school sessions.

Recommended contract:

```text
POST /api/v1/voice/session
POST /api/v1/voice/turn
POST /api/v1/voice/tool-result
POST /api/v1/voice/session/:id/end
```

A voice turn should carry at minimum:

- tenant/school identity;
- authenticated user or room identity;
- session ID;
- transcript text;
- language;
- channel (`watch`, `classroom`, `phone`, `reception`, `teacher`);
- optional class/student context only when permitted;
- request timestamp and trace ID.

The response should contain:

- answer text;
- language;
- optional tool/action result;
- whether human approval is required;
- whether the session should transfer to a human;
- trace/provider/model metadata for admin diagnostics.

## Local AI mode

For school deployments, prefer the self-hosted KobeVoice stack where practical:

```text
STT       -> Whisper
Reasoning -> KobeAI Router -> PAIR/direct Ollama
TTS       -> Chatterbox
Media     -> self-hosted LiveKit
```

This keeps most classroom audio and inference on school-controlled infrastructure. Telephony still requires a carrier/SIP connection when real phone numbers are used.

## Swahili

KobeVoice's selected functional branch already supports configuring Swahili for the local speech stack. KobeAI should preserve detected/requested language across the whole turn so STT, router prompts and TTS do not disagree about language.

The LLM's Swahili quality must be tested separately from TTS pronunciation. A fluent voice does not guarantee good Swahili reasoning or wording.

## Security and privacy rules

- Never expose the current trust-only tenant header model to the public internet; replace it with signed service/user authentication before production.
- Audio recording must be opt-in/authorized according to the deployment policy; real-time voice does not require retaining every recording.
- Student identity/context should be attached only when needed and authorized.
- Classroom ambient listening needs clear teacher/admin controls and visible listening state.
- Voice cloning requires explicit permission from the voice owner.
- High-impact actions (payments, destructive changes, external publishing, disciplinary actions) require explicit authorization/human approval.
- Keep an audit trail of voice-originated tool actions.
- CubeSandbox credentials should be scoped and short-lived.
- PAIR nodes must belong to the trusted school cluster before student data is routed through them.

## Deployment order

1. Initialize the submodule and run KobeVoice locally.
2. Run its local LiveKit/STT/TTS stack and measure English + Swahili latency.
3. Add the KobeAI `/api/v1/voice/*` gateway.
4. Change the school-oriented KobeVoice agent to use KobeAI Router instead of its own direct Ollama call.
5. Add watch/browser/classroom LiveKit clients.
6. Connect PAIR behind the KobeAI Router for distributed LLM inference.
7. Add CubeSandbox only for tool/agent actions that need isolated execution.
8. Add SIP/GSM telephony after the local voice loop is stable.
9. Replace temporary tenant authentication and configure jurisdiction-appropriate consent/calling rules before public calling.

The immediate milestone should be a local end-to-end school voice loop: **microphone -> STT -> KobeAI Router -> TTS -> speaker**, with no telephony dependency.