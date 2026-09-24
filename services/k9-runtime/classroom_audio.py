from __future__ import annotations
import hashlib, math, time
from dataclasses import dataclass, field

@dataclass
class VoiceProfile:
    student_id: str
    student_name: str
    embeddings: list[list[float]] = field(default_factory=list)
    consent: bool = False

class ClassroomVoiceRegistry:
    """Stores speaker embeddings, not raw enrollment recordings by default."""
    def __init__(self):
        self.profiles: dict[str, VoiceProfile] = {}
    def enroll(self, student_id, student_name, embeddings, consent):
        if not consent: raise PermissionError("voice_enrollment_requires_consent")
        if len(embeddings) < 3: raise ValueError("capture_at_least_3_voice_samples")
        self.profiles[student_id]=VoiceProfile(student_id,student_name,embeddings,True)
        return {"student_id":student_id,"student_name":student_name,"samples":len(embeddings)}
    @staticmethod
    def cosine(a,b):
        dot=sum(x*y for x,y in zip(a,b)); na=math.sqrt(sum(x*x for x in a)); nb=math.sqrt(sum(y*y for y in b))
        return dot/(na*nb) if na and nb else 0.0
    def identify(self, embedding, threshold=.72):
        best=None
        for p in self.profiles.values():
            score=max((self.cosine(embedding,e) for e in p.embeddings),default=0)
            if best is None or score>best[1]: best=(p,score)
        if not best or best[1] < threshold: return {"student_id":None,"confidence":best[1] if best else 0}
        return {"student_id":best[0].student_id,"student_name":best[0].student_name,"confidence":best[1]}

SUBJECT_AGENTS={
 "mathematics":{"voice":"teacher-a","style":"step_by_step"},
 "physics":{"voice":"teacher-b","style":"concept_then_example"},
 "chemistry":{"voice":"teacher-c","style":"safety_first_experimental"},
 "biology":{"voice":"teacher-d","style":"visual_explanatory"},
 "english":{"voice":"teacher-e","style":"language_coach"},
 "kiswahili":{"voice":"teacher-f","style":"kiswahili_teacher"},
 "history":{"voice":"teacher-g","style":"story_evidence"},
 "geography":{"voice":"teacher-h","style":"maps_systems"},
 "civics":{"voice":"teacher-i","style":"neutral_civic_education"},
 "computer_science":{"voice":"teacher-j","style":"code_and_concepts"}
}

def agent_for(subject:str):
    return SUBJECT_AGENTS.get(subject.lower(),{"voice":"teacher-a","style":"general_teacher"})
