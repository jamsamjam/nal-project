from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from pathlib import Path
import csv
import subprocess


class RunRequest(BaseModel):
    layers: int = 3
    k: int = 4
    torCount: int = 2
    aggCount: int = 2
    serversPerTor: int = 8
    linkRate: str = "10Mbps"
    linkDelay: str = "1ms"
    tcp: str = "TcpNewReno"
    queue: str = "FifoQueueDisc"


app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

ns3_path = Path("../ns3").resolve()
output_path = Path("./output").resolve()
output_path.mkdir(exist_ok=True)

app.mount("/output", StaticFiles(directory=output_path), name="output")


def build_run_tag(req: RunRequest) -> str:
    tcp_variant = req.tcp.split("::")[-1]
    return (
        f"L{req.layers}_k{req.k}_t{req.torCount}_a{req.aggCount}_s{req.serversPerTor}"
        f"_d{req.linkDelay}_r{req.linkRate}_tcp{tcp_variant}"
    )


def ns3_type(name: str) -> str:
    return name if name.startswith("ns3::") else f"ns3::{name}"


def get_link_ids(run_tag: str) -> list[str]:
    run_dir = output_path / run_tag
    if not run_dir.exists():
        raise HTTPException(status_code=404, detail=f"Run '{run_tag}' not found.")

    csv_files = sorted(run_dir.glob("packets_*.csv"))
    return [f.stem.replace("packets_", "") for f in csv_files]


@app.post("/run")
def run(req: RunRequest):
    run_tag = build_run_tag(req)
    run_dir = output_path / run_tag

    if not run_dir.exists():
        args = [
            "./ns3", "run", "scratch/DCN", "--",
            f"--layers={req.layers}",
            f"--k={req.k}",
            f"--torCount={req.torCount}",
            f"--aggCount={req.aggCount}",
            f"--serversPerTor={req.serversPerTor}",
            f"--linkRate={req.linkRate}",
            f"--linkDelay={req.linkDelay}",
            f"--tcp={ns3_type(req.tcp)}",
            f"--queue={ns3_type(req.queue)}",
        ]

        try:
            subprocess.run(args, cwd=ns3_path, check=True)
        except subprocess.CalledProcessError as e:
            raise HTTPException(status_code=500, detail=f"ns-3 run failed: {e}")

    link_ids = get_link_ids(run_tag)
    return {
        "runTag": run_tag,
        "linkIds": link_ids,
    }


@app.get("/results/{run_tag}")
def get_run_results(run_tag: str):
    link_ids = get_link_ids(run_tag)
    return {"runTag": run_tag, "linkIds": link_ids}


@app.get("/results/{run_tag}/link/{link_id}")
def get_link_packets(run_tag: str, link_id: str):
    csv_path = output_path / run_tag / f"packets_{link_id}.csv"
    if not csv_path.exists():
        raise HTTPException(status_code=404, detail=f"Link '{link_id}' not found in run '{run_tag}'.")

    packets = []
    with open(csv_path, newline="") as f:
        for row in csv.DictReader(f):
            packets.append({
                "id": int(row["id"]),
                "size": int(row["size"]),
                "enqueue_time": int(row["enqueue_time"]) / 1e9,
                "dequeue_time": int(row["dequeue_time"]) / 1e9,
                "arrive_time": int(row["arrive_time"]) / 1e9,
            })
    return {"linkId": link_id, "packets": packets}
