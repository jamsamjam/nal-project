# DCN Network Visualization

>[!NOTE]
> This is a semester project currently being updated and planned to be finalized by June.

```mermaid
flowchart LR
    A[Layer Selection]

    A -->|1-layer| B1[1 ToR]
    A -->|2-layer| B2[ToR and Agg]
    A -->|3-layer| B3[Fat-tree Pods]

    B1 --> C[Servers per ToR]
    B2 --> C
    B3 --> D[Topology Size]

    C --> E[Link Rate/Delay]
    D --> E

    E --> F[TCP/Queue]
    F --> G[Workload]
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


