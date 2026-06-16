from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel
from pathlib import Path
import shutil
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
    load: float = 50.0
    workload: str = "Google_AllRPC"


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


def normalize_run_tag(run_tag: str) -> str:
    return run_tag.replace("/", "_").replace(" ", "_")


def build_run_tag(req: RunRequest) -> str:
    tcp_variant = req.tcp.split("::")[-1]
    queue_variant = req.queue.split("::")[-1]
    server_to_tor_rate = req.serverToTorRate or req.linkRate
    tor_to_agg_rate = req.torToAggRate or server_to_tor_rate
    agg_to_core_rate = req.aggToCoreRate or tor_to_agg_rate
    run_tag = (
        f"L{req.layers}_k{req.k}_t{req.torCount}_a{req.aggCount}_s{req.serversPerTor}"
        f"_d{req.linkDelay}"
        f"_rsta{server_to_tor_rate}"
        f"_rta{tor_to_agg_rate}"
        f"_rac{agg_to_core_rate}"
        f"_tcp{tcp_variant}_q{queue_variant}"
        f"_load{req.load:g}_w{req.workload}"
    )
    if queue_variant == "RedQueueDisc":
        run_tag += f"_redmin{req.redMinThresholdPct:g}_redmax{req.redMaxThresholdPct:g}"
    return normalize_run_tag(run_tag)


def ns3_type(name: str) -> str:
    return name if name.startswith("ns3::") else f"ns3::{name}"


def completion_marker(run_dir: Path) -> Path:
    return run_dir / ".complete"


def is_completed_run_dir(run_dir: Path) -> bool:
    return run_dir.exists() and completion_marker(run_dir).exists()


def mark_run_complete(run_dir: Path):
    completion_marker(run_dir).touch()


def remove_incomplete_run_dir(run_dir: Path):
    if run_dir.exists() and not is_completed_run_dir(run_dir):
        shutil.rmtree(run_dir)


def get_link_ids(run_tag: str) -> list[str]:
    run_dir = output_path / run_tag
    if not is_completed_run_dir(run_dir):
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
        remove_incomplete_run_dir(run_dir)

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
                f"--load={req.load}",
                f"--workload={req.workload}",
                f"--runTag={run_tag}",
            ]
            subprocess.run(args, cwd=ns3_path, check=True)

        mark_run_complete(run_dir)
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

    if is_completed_run_dir(run_dir):
        return RunStatus(runTag=run_tag, status="completed", linkIds=get_link_ids(run_tag))

    remove_incomplete_run_dir(run_dir)
    set_job_status(run_tag, "queued")
    Thread(target=launch_run, args=(req, run_tag), daemon=True).start()
    return get_job_status(run_tag)


@app.get("/runs/{run_tag}/status")
def get_run_status(run_tag: str):
    run_dir = output_path / run_tag
    if is_completed_run_dir(run_dir):
        completed = RunStatus(runTag=run_tag, status="completed", linkIds=get_link_ids(run_tag))
        set_job_status(run_tag, "completed", link_ids=completed.linkIds)
        return completed

    status = get_job_status(run_tag)
    if status and status.status in {"queued", "running", "failed"}:
        return status

    if status is None:
        raise HTTPException(status_code=404, detail=f"Run '{run_tag}' not found.")
    return status


@app.get("/results/{run_tag}")
def get_run_results(run_tag: str):
    link_ids = get_link_ids(run_tag)
    return {"runTag": run_tag, "linkIds": link_ids}


@app.get("/results/{run_tag}/link/{link_id}")
def get_link_packets(run_tag: str, link_id: str):
    run_dir = output_path / run_tag
    if not is_completed_run_dir(run_dir):
        raise HTTPException(status_code=404, detail=f"Run '{run_tag}' not found.")

    csv_path = run_dir / f"packets_{link_id}.csv"
    if not csv_path.exists():
        raise HTTPException(status_code=404, detail=f"Link '{link_id}' not found in run '{run_tag}'.")
    return FileResponse(csv_path, media_type="text/csv")
