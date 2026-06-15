# DCN Network Visualization

>[!NOTE]
> This is a semester project currently being updated and planned to be finalized by June.

```mermaid
flowchart LR

    A[# Layers?]

    A -->|1| L1[1 ToR]
    L1 --> L1S[# Servers per ToR]
    L1S --> D[linkrate, delay]
    D --> C[congestion/queue algo]
    C --> W[workload: load, msgDist]

    A -->|2| L2[# ToRs, # Agg]
    L2 --> L1S

    A -->|3| L3[ToR + Aggregation + Core]
    L3 --> L3N[# Pods]
    L3N --> D
```

## Quick Start

```bash
# cd backend && uv run fastapi dev main.py
cd backend && uv run fastapi run --port 8001
cd frontend && npm run dev
```

```bash
tmux
./ns3 build -j1
```

## Tech Stack

| Layer        | Stack |
|--------------|------------------|
| Frontend     | React, Next.js |
| Backend      | FastAPI, RQ |
| Simulation   | ns-3 |
<!-- | Storage      | AWS | -->


