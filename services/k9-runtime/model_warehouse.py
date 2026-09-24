from __future__ import annotations
import json, os
from pathlib import Path

CONFIG = Path(__file__).resolve().parents[2] / "config" / "model-warehouse.json"

class ModelWarehouse:
    def __init__(self):
        self.config = json.loads(CONFIG.read_text(encoding="utf-8"))
        self.root = Path(os.getenv(self.config["root_env"], self.config["default_root"]))
    def scan(self):
        found=[]
        for model_id, meta in self.config["known"].items():
            path=self.root / meta["path"]
            status="missing"
            if path.exists():
                status="blocked" if model_id in self.config.get("production_blocklist",[]) or not meta.get("commercial",False) else "ready"
            found.append({"id":model_id, **meta, "path":str(path), "status":status})
        return found
    def route(self, category):
        for m in self.scan():
            if m["category"]==category and m["status"]=="ready": return m
        raise FileNotFoundError(f"no_ready_model:{category}")
warehouse=ModelWarehouse()
