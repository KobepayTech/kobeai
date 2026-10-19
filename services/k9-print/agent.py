#!/usr/bin/env python3
"""CUPS bridge. Claims once; never automatically reprints an ambiguous job.
Set K9_SERVER_URL (including /api), K9_PRINT_AGENT_SECRET, K9_PRINTER_ID,
CUPS_PRINTER. A staff member confirms physical output before settlement.
"""
import json, os, subprocess, tempfile, time, urllib.request
BASE=os.environ['K9_SERVER_URL'].rstrip('/')
SECRET=os.environ['K9_PRINT_AGENT_SECRET']
PRINTER=os.environ['K9_PRINTER_ID']
CUPS=os.environ['CUPS_PRINTER']

def request(path, body=None, claim=None):
    headers={'x-print-agent-secret':SECRET}
    if claim: headers['x-print-claim']=claim
    if body is not None: headers['Content-Type']='application/json'
    req=urllib.request.Request(BASE+path,data=None if body is None else json.dumps(body).encode(),headers=headers)
    with urllib.request.urlopen(req,timeout=60) as response: return response.read()

def tick():
    job=json.loads(request('/v1/learning-pack-agent/claim',{'printer_id':PRINTER}))['job']
    if not job: return
    # Any error after claim leaves the job held for office reconciliation.
    # In particular, a timeout from lp or the status callback MUST NOT reprint.
    pdf=request(f"/v1/learning-pack-agent/{job['id']}/pdf",claim=job['claim_token'])
    with tempfile.NamedTemporaryFile(suffix='.pdf') as f:
        f.write(pdf);f.flush()
        result=subprocess.run(['lp','-d',CUPS,'-n','1','-o','media=A4','-o','sides=two-sided-long-edge',f.name],check=True,capture_output=True,text=True,timeout=60)
    request(f"/v1/learning-pack-agent/{job['id']}/submitted",{'printer_job_id':result.stdout.strip()},job['claim_token'])
    print(f"Pack {job['id']} submitted; office must confirm printed output",flush=True)

if __name__=='__main__':
    while True:
        try: tick()
        except Exception as exc: print(f'Printing held for reconciliation: {exc}',flush=True)
        time.sleep(5)
