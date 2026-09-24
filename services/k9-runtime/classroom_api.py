from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from classroom_audio import ClassroomVoiceRegistry, agent_for
from model_warehouse import warehouse

router=APIRouter(prefix="/v1/classroom",tags=["classroom-voice"])
voices=ClassroomVoiceRegistry()

class Enroll(BaseModel):
    student_id:str
    student_name:str
    embeddings:list[list[float]]
    consent:bool=False

class Turn(BaseModel):
    speaker_embedding:list[float]
    transcript:str=Field(min_length=1)
    subject:str="general"
    classroom_id:str|None=None

@router.get("/models")
def models(): return warehouse.scan()

@router.post("/models/rescan")
def rescan(): return warehouse.scan()

@router.post("/voice/enroll")
def enroll(req:Enroll):
    try: return voices.enroll(req.student_id,req.student_name,req.embeddings,req.consent)
    except (ValueError,PermissionError) as exc: raise HTTPException(400,str(exc))

@router.post("/voice/identify")
def identify(req:Turn):
    who=voices.identify(req.speaker_embedding)
    return {**who,"transcript":req.transcript,"subject":req.subject,"agent":agent_for(req.subject),"classroom_id":req.classroom_id}

@router.get("/agents/{subject}")
def subject_agent(subject:str): return agent_for(subject)
