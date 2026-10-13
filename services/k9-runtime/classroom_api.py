"""Classroom metadata for the containerised runtime.

What this serves: which models the warehouse can route to, and which voice and
style a subject gets. What it deliberately does not serve: speaker enrolment or
identification.

Those moved to the school server, which holds the class roster, the consent
record and the audit trail — `POST /v1/voice/enroll` and `POST /v1/voice/identify`
in `artifacts/api-server/src/routes/voice-enrollment.ts`. Audio inference lives
in `services/k9-runtime/server.py` (`/v1/speaker/embedding`, `/v1/diarize`,
`/v1/transcribe`), which is the runtime a school PC actually starts.

So the chain is:

    classroom mic → gateway → server.py (VAD, diarize, embed, transcribe)
                            → school server (roster, identity decision, profile)
                            → subject agent → screen and speaker
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException

from classroom_audio import SUBJECT_AGENTS, agent_for
from model_warehouse import ModelNotReady, warehouse

router = APIRouter(prefix="/v1/classroom", tags=["classroom"])


@router.get("/models")
def models() -> list[dict]:
    """Every registry model with its licence position and whether it is usable."""
    return warehouse.scan()


@router.get("/capabilities")
def capabilities() -> dict:
    return {"capabilities": warehouse.capabilities()}


@router.get("/route/{capability}")
def route(capability: str) -> dict:
    """Which model will serve a capability here — or exactly why none can."""
    try:
        return warehouse.route(capability)
    except ModelNotReady as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@router.get("/agents")
def agents() -> dict:
    return {"agents": SUBJECT_AGENTS, "default": agent_for(None)}


@router.get("/agents/{subject}")
def subject_agent(subject: str) -> dict:
    return {"subject": subject, **agent_for(subject)}
