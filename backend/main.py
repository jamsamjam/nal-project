from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from pathlib import Path
import csv
import subprocess
from threading import Lock, Thread
from typing import Literal


class RunRequest(BaseModel):
    layers: int = 3
    k: int = 4
    torCount: int = 2
    aggCount: int = 2
    serversPerTor: int = 8
    linkRate: str = "10Mbps"
    serverToTorRate: str | None = None
    torToAggRate: str | None = None
    aggToCoreRate: str | None = None
    linkDelay: str = "1ms"
    tcp: str = "TcpNewReno"
    queue: str = "FifoQueueDisc"
    redMinThresholdPct: float = 20.0
    redMaxThresholdPct: float = 60.0


class RunStatus(BaseModel):
    runTag: str
    status: Literal["queued", "running", "completed", "failed"]
    linkIds: list[str] = []
    error: str | None = None


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
_ns3_ready_lock = Lock()
_run_jobs_lock = Lock()
_run_jobs: dict[str, RunStatus] = {}

app.mount("/output", StaticFiles(directory=output_path), name="output")


def build_run_tag(req: RunRequest) -> str:
    tcp_variant = req.tcp.split("::")[-1]
    queue_variant = req.queue.split("::")[-1]
    server_to_tor_rate = req.serverToTorRate or req.linkRate
    tor_to_agg_rate = req.torToAggRate or server_to_tor_rate
    agg_to_core_rate = req.aggToCoreRate or tor_to_agg_rate
    return (
        f"L{req.layers}_k{req.k}_t{req.torCount}_a{req.aggCount}_s{req.serversPerTor}"
        f"_d{req.linkDelay}"
        f"_rsta{server_to_tor_rate}"
        f"_rta{tor_to_agg_rate}"
        f"_rac{agg_to_core_rate}"
        f"_tcp{tcp_variant}_q{queue_variant}"
        f"_redmin{req.redMinThresholdPct:g}_redmax{req.redMaxThresholdPct:g}"
    )


def ns3_type(name: str) -> str:
    return name if name.startswith("ns3::") else f"ns3::{name}"


def get_link_ids(run_tag: str) -> list[str]:
    run_dir = output_path / run_tag
    if not run_dir.exists():
        raise HTTPException(status_code=404, detail=f"Run '{run_tag}' not found.")

    csv_files = sorted(run_dir.glob("packets_*.csv"))
    return [f.stem.replace("packets_", "") for f in csv_files]


def get_job_status(run_tag: str) -> RunStatus | None:
    with _run_jobs_lock:
        status = _run_jobs.get(run_tag)
        return status.model_copy() if status else None


def set_job_status(run_tag: str, status: Literal["queued", "running", "completed", "failed"], link_ids: list[str] | None = None, error: str | None = None):
    with _run_jobs_lock:
        _run_jobs[run_tag] = RunStatus(
            runTag=run_tag,
            status=status,
            linkIds=link_ids or [],
            error=error,
        )


def ensure_ns3_ready():
    with _ns3_ready_lock:
        build_dir = ns3_path / "build"
        if build_dir.exists():
            return

        try:
            subprocess.run(["./ns3", "configure"], cwd=ns3_path, check=True)
            subprocess.run(["./ns3", "build"], cwd=ns3_path, check=True)
        except subprocess.CalledProcessError as e:
            raise HTTPException(status_code=500, detail=f"ns-3 setup failed: {e}")


def launch_run(req: RunRequest, run_tag: str):
    run_dir = output_path / run_tag
    server_to_tor_rate = req.serverToTorRate or req.linkRate
    tor_to_agg_rate = req.torToAggRate or server_to_tor_rate
    agg_to_core_rate = req.aggToCoreRate or tor_to_agg_rate

    try:
        set_job_status(run_tag, "running")
        ensure_ns3_ready()

        if not run_dir.exists():
            args = [
                "./ns3", "run", "scratch/DCN", "--",
                f"--layers={req.layers}",
                f"--k={req.k}",
                f"--torCount={req.torCount}",
                f"--aggCount={req.aggCount}",
                f"--serversPerTor={req.serversPerTor}",
                f"--linkRate={req.linkRate}",
                f"--serverToTorRate={server_to_tor_rate}",
                f"--torToAggRate={tor_to_agg_rate}",
                f"--aggToCoreRate={agg_to_core_rate}",
                f"--linkDelay={req.linkDelay}",
                f"--tcp={ns3_type(req.tcp)}",
                f"--queue={ns3_type(req.queue)}",
                f"--redMinThresholdPct={req.redMinThresholdPct}",
                f"--redMaxThresholdPct={req.redMaxThresholdPct}",
            ]
            subprocess.run(args, cwd=ns3_path, check=True)

        set_job_status(run_tag, "completed", link_ids=get_link_ids(run_tag))
    except subprocess.CalledProcessError as e:
        set_job_status(run_tag, "failed", error=f"ns-3 run failed: {e}")
    except HTTPException as e:
        set_job_status(run_tag, "failed", error=str(e.detail))
    except Exception as e:  # noqa: BLE001
        set_job_status(run_tag, "failed", error=f"Unexpected error: {e}")


@app.post("/run")
def run(req: RunRequest):
    run_tag = build_run_tag(req)
    run_dir = output_path / run_tag
    existing = get_job_status(run_tag)

    if existing and existing.status in {"queued", "running"}:
        return existing

    if not run_dir.exists():
        set_job_status(run_tag, "queued")
        Thread(target=launch_run, args=(req, run_tag), daemon=True).start()
        return get_job_status(run_tag)

    return RunStatus(runTag=run_tag, status="completed", linkIds=get_link_ids(run_tag))


@app.get("/runs/{run_tag}/status")
def get_run_status(run_tag: str):
    status = get_job_status(run_tag)
    if status and status.status in {"queued", "running", "failed"}:
        return status

    run_dir = output_path / run_tag
    if run_dir.exists():
        return RunStatus(runTag=run_tag, status="completed", linkIds=get_link_ids(run_tag))

    if status is None:
        raise HTTPException(status_code=404, detail=f"Run '{run_tag}' not found.")
    return status


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

    def parse_required_int(row: dict[str, str], key: str) -> int:
        value = row.get(key)
        if value is None:
            raise ValueError(f"missing '{key}'")
        value = value.strip()
        if value == "":
            raise ValueError(f"empty '{key}'")
        return int(value)

    with open(csv_path, newline="") as f:
        for row_idx, row in enumerate(csv.DictReader(f), start=2):
            try:
                packets.append({
                    "id": parse_required_int(row, "id"),
                    "size": parse_required_int(row, "size"),
                    "enqueue_time": parse_required_int(row, "enqueue_time") / 1e9,
                    "dequeue_time": parse_required_int(row, "dequeue_time") / 1e9,
                    "arrive_time": parse_required_int(row, "arrive_time") / 1e9,
                })
            except (ValueError, TypeError):
                # Skip malformed/blank rows instead of failing the whole response.
                continue
    return {"linkId": link_id, "packets": packets}
