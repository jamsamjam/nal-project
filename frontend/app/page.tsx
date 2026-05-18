"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type PacketRow = {
  id: number;
  size: number;
  enqueue_time: number;
  dequeue_time: number;
  arrive_time: number;
};

type RunResult = { runTag: string; linkIds: string[] };

type Node = {
  id: string;
  label: string;
  type: "core" | "agg" | "access" | "host";
  x: number;
  y: number;
};

type Link = { from: string; to: string };

type Dot = { key: string; x: number; y: number };

// 3 -> pod-0-host-1-1
function numericToSvgId(num: number, k: number): string {
  const half = k / 2;
  const numHosts = (k * k * k) / 4;
  const numTor = (k * k) / 2;
  const numAgg = (k * k) / 2;

  if (num < numHosts) {
    const p = Math.floor(num / (half * half));
    const rem = num % (half * half);
    return `pod-${p}-host-${Math.floor(rem / half)}-${rem % half}`;
  }
  if (num < numHosts + numTor) {
    const off = num - numHosts;
    return `pod-${Math.floor(off / half)}-access-${off % half}`;
  }
  if (num < numHosts + numTor + numAgg) {
    const off = num - numHosts - numTor;
    return `pod-${Math.floor(off / half)}-agg-${off % half}`;
  }
  return `core-${num - numHosts - numTor - numAgg}`;
}

// "12-34" -> [svgId, svgId]
function parseLinkSvgIds(linkId: string, k: number): [string, string] | null {
  const parts = linkId.split("-");
  if (parts.length !== 2) return null;
  const from = parseInt(parts[0]);
  const to = parseInt(parts[1]);
  if (isNaN(from) || isNaN(to)) return null;
  return [numericToSvgId(from, k), numericToSvgId(to, k)];
}

// "pod-0-host-0-0" -> 0
function svgIdToNumeric(svgId: string, k: number): number {
  const half = k / 2;
  const numHosts = (k * k * k) / 4;
  const numTor = (k * k) / 2;
  const numAgg = (k * k) / 2;
  const core = svgId.match(/^core-(\d+)$/);
  if (core) return numHosts + numTor + numAgg + Number(core[1]);
  const agg = svgId.match(/^pod-(\d+)-agg-(\d+)$/);
  if (agg) return numHosts + numTor + Number(agg[1]) * half + Number(agg[2]);
  const acc = svgId.match(/^pod-(\d+)-access-(\d+)$/);
  if (acc) return numHosts + Number(acc[1]) * half + Number(acc[2]);
  const host = svgId.match(/^pod-(\d+)-host-(\d+)-(\d+)$/);
  if (host) return Number(host[1]) * half * half + Number(host[2]) * half + Number(host[3]);
  return -1;
}

function csvIdsForSvgLink(svgFrom: string, svgTo: string, k: number, packets: Record<string, PacketRow[]>): string[] {
  const a = svgIdToNumeric(svgFrom, k);
  const b = svgIdToNumeric(svgTo, k);
  if (a < 0 || b < 0) return [];
  return [`${a}-${b}`, `${b}-${a}`].filter(id => id in packets);
}

function parseQueueCapacityBytes(linkRate: string, linkDelay: string): number {
  const r = linkRate.trim();
  let bps = 0;
  if (r.endsWith("Gbps")) bps = parseFloat(r) * 1e9;
  else if (r.endsWith("Mbps")) bps = parseFloat(r) * 1e6;
  else if (r.endsWith("Kbps")) bps = parseFloat(r) * 1e3;
  else bps = parseFloat(r);

  const d = linkDelay.trim();
  let delayS = 0;
  if (d.endsWith("ms")) delayS = parseFloat(d) * 1e-3;
  else if (d.endsWith("us")) delayS = parseFloat(d) * 1e-6;
  else if (d.endsWith("ns")) delayS = parseFloat(d) * 1e-9;
  else delayS = parseFloat(d);

  return Math.max(1, Math.floor(bps * delayS / 8));
} // TODO


function buildFatTree(k: number, startX: number) {
  const nodes: Node[] = [];
  const links: Link[] = [];

  if (!Number.isInteger(k) || k < 2 || k % 2 !== 0) {
    return { nodes, links, error: "k must be an even integer >= 2" };
  }

  const half = k / 2;
  const podWidth = 220;
  const coreY = 60;
  const aggY = 180;
  const accessY = 300;
  const hostY = 420;

  const coreCount = half * half;
  const podSpan = (k - 1) * podWidth + (half - 1) * 70;
  const coreSpan = (coreCount - 1) * 90;
  const coreStartX = startX + (podSpan - coreSpan) / 2;

  for (let i = 0; i < coreCount; i++) {
    nodes.push({ id: `core-${i}`, label: `C${i}`, type: "core", x: coreStartX + i * 90, y: coreY });
  }

  for (let p = 0; p < k; p++) {
    const podX = startX + p * podWidth;
    for (let a = 0; a < half; a++) {
      const aggId = `pod-${p}-agg-${a}`;
      nodes.push({ id: aggId, label: `P${p} A${a}`, type: "agg", x: podX + a * 70, y: aggY });
      for (let c = 0; c < half; c++) links.push({ from: aggId, to: `core-${a * half + c}` });
    }
    for (let e = 0; e < half; e++) {
      const accessId = `pod-${p}-access-${e}`;
      nodes.push({ id: accessId, label: `P${p} E${e}`, type: "access", x: podX + e * 70, y: accessY });
      for (let a = 0; a < half; a++) links.push({ from: accessId, to: `pod-${p}-agg-${a}` });
      for (let h = 0; h < half; h++) {
        const hostId = `pod-${p}-host-${e}-${h}`;
        nodes.push({ id: hostId, label: `H${p}.${e}.${h}`, type: "host", x: podX + e * 70 - 18 + h * 36, y: hostY });
        links.push({ from: hostId, to: accessId });
      }
    }
  }

  return { nodes, links, error: null };
}

function nodeStroke(type: Node["type"]) {
  if (type === "core") return "rgb(186, 186, 186)";
  if (type === "agg") return "rgb(62, 117, 255)";
  if (type === "access") return "rgb(138, 197, 255)";
  return "rgb(212, 212, 216)";
}

function queueColor(ratio: number, fallback: string): string {
  if (ratio > 0.5) return "rgb(72, 66, 229))"
  else if (ratio > 0.6) return "rgb(97, 93, 217))"
  else if (ratio > 0.8) return "rgb(42, 34, 255)";
  return fallback;
}

export default function Home() {
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [linkRate, setLinkRate] = useState("10Mbps");
  const [linkDelay, setLinkDelay] = useState("1ms");
  const [k, setK] = useState("4");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [runResult, setRunResult] = useState<RunResult | null>(null);

  const [packets, setPackets] = useState<Record<string, PacketRow[]>>({});
  const [fetchingPackets, setFetchingPackets] = useState(false);

  const [animTime, setAnimTime] = useState(0);
  const [animating, setAnimating] = useState(false);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedQueueCsvId, setSelectedQueueCsvId] = useState<string | null>(null);

  const animRaf = useRef<number | null>(null);
  const animStartSim = useRef(0);

  useEffect(() => {
    const saved = localStorage.getItem("theme");
    const next = saved === "light" ? "light" : "dark";
    setTheme(next);
    document.documentElement.classList.toggle("dark", next === "dark");
  }, []);

  function toggleTheme() {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    localStorage.setItem("theme", next);
    document.documentElement.classList.toggle("dark", next === "dark");
  }

  const numericK = Number(k);
  const svgWidth = Math.max(900, numericK * 220);
  const svgHeight = 500;
  const startX = 80;

  const topology = useMemo(() => buildFatTree(numericK, startX), [numericK, startX]);
  const nodeMap = useMemo(
    () => new Map(topology.nodes.map((n) => [n.id, n])),
    [topology.nodes]
  );

  const lineStroke = theme === "dark" ? "rgb(68, 64, 60)" : "rgb(214, 211, 209)";
  const nodeFill = theme === "dark" ? "rgb(28, 25, 23)" : "rgb(255, 255, 255)";

  const simEndTime = useMemo(() => {
    let max = 0;
    for (const pkts of Object.values(packets))
      for (const p of pkts) if (p.arrive_time > max) max = p.arrive_time;
    return max > 0 ? max : 10;
  }, [packets]);

  const queueCapacityBytes = useMemo(
    () => parseQueueCapacityBytes(linkRate, linkDelay),
    [linkRate, linkDelay]
  );

  // per-frame: packet dots + current queue depths
  const { dots: packetDots, depths: linkQueueDepths } = useMemo(() => {
    const dots: Dot[] = [];
    const depths: Record<string, number> = {}; // link `string` -> current queue byte

    for (const [linkId, pkts] of Object.entries(packets)) {
      const ids = parseLinkSvgIds(linkId, numericK);
      const fromNode = ids ? nodeMap.get(ids[0]) : null;
      const toNode = ids ? nodeMap.get(ids[1]) : null;
      let depth = 0;

      // A -> B: displayed above, A <- B: below
      let perpX = 0;
      let perpY = 0;
      if (fromNode && toNode) {
        const parts = linkId.split("-");
        const offsetSign = parseInt(parts[0]) < parseInt(parts[1]) ? 1 : -1;
        const dx = toNode.x - fromNode.x;
        const dy = toNode.y - fromNode.y;
        const len = Math.sqrt(dx * dx + dy * dy);
        if (len > 0) {
          perpX = (-dy / len) * offsetSign * 5;
          perpY = (dx / len) * offsetSign * 5;
        }
      }

      for (const p of pkts) {
        if (p.enqueue_time <= animTime && p.dequeue_time >= animTime) {
          depth += p.size;
        }

        if (p.dequeue_time <= animTime && p.arrive_time >= animTime && fromNode && toNode) {
          const dur = p.arrive_time - p.dequeue_time;
          const progress = Math.min((animTime - p.dequeue_time) / dur, 1);
          dots.push({
            key: `${linkId}-${p.id}`,
            x: fromNode.x + (toNode.x - fromNode.x) * progress + perpX,
            y: fromNode.y + (toNode.y - fromNode.y) * progress + perpY,
          });
        }
      }
      depths[linkId] = depth;
    }
    return { dots, depths };
  }, [animTime, packets, nodeMap, numericK]);

  const hasPackets = Object.keys(packets).length > 0;

  const selectedInfo = useMemo(() => {
    if (!selectedQueueCsvId) return null;
    const pkts = packets[selectedQueueCsvId];
    const parts = selectedQueueCsvId.split("-");
    const fromLabel = nodeMap.get(numericToSvgId(parseInt(parts[0]), numericK))?.label ?? parts[0];
    const toLabel = nodeMap.get(numericToSvgId(parseInt(parts[1]), numericK))?.label ?? parts[1];
    const currentBytes = pkts?.filter(p => p.enqueue_time <= animTime && p.dequeue_time >= animTime).reduce((s, p) => s + p.size, 0) ?? 0;
    const ratio = currentBytes / queueCapacityBytes;
    return { label: `${fromLabel} → ${toLabel}`, currentBytes, capacityBytes: queueCapacityBytes, ratio };
  }, [selectedQueueCsvId, packets, animTime, queueCapacityBytes, numericK, nodeMap]);

  useEffect(() => {
    if (!animating) {
      if (animRaf.current !== null) { cancelAnimationFrame(animRaf.current); animRaf.current = null; }
      return;
    }
    const wallStart = performance.now();
    const simStart = animStartSim.current;
    function frame() {
      const sim = simStart + (performance.now() - wallStart) / (1000 * 30);
      if (sim >= simEndTime) { setAnimTime(simEndTime); setAnimating(false); return; }
      setAnimTime(sim);
      animRaf.current = requestAnimationFrame(frame);
    }
    animRaf.current = requestAnimationFrame(frame);
    return () => { if (animRaf.current !== null) { cancelAnimationFrame(animRaf.current); animRaf.current = null; } };
  }, [animating, simEndTime]);

  function toggleAnim() {
    if (animating) {
      setAnimating(false);
    } else {
      const resumeFrom = animTime >= simEndTime ? 0 : animTime;
      animStartSim.current = resumeFrom;
      setAnimTime(resumeFrom);
      setAnimating(true);
    }
  }

  async function runSimulation() {
    // initialize exisiting output
    setLoading(true);
    setError(null);
    setRunResult(null);
    setPackets({});
    setAnimating(false);
    setAnimTime(0);
    setSelectedNodeId(null);
    setSelectedQueueCsvId(null);

    try {
      const res = await fetch("/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ linkRate, linkDelay, k: Number(k) }),
      });
      if (!res.ok) throw new Error(`Backend Error: ${res.status}`);
      const data: RunResult = await res.json();
      setRunResult(data);

      setFetchingPackets(true);
      const fetched: Record<string, PacketRow[]> = {};
      await Promise.all(
        data.linkIds.map(async (linkId) => {
          const r = await fetch(`/results/${data.runTag}/link/${linkId}`); // TODO
          if (r.ok) {
            const d = await r.json();
            fetched[linkId] = d.packets;
          }
        })
      );
      setPackets(fetched);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
      setFetchingPackets(false);
    }
  }

  return (
    <>
      <button
        onClick={toggleTheme}
        className="fixed right-5 top-5 z-50 flex h-10 w-10 items-center justify-center rounded-full border border-stone-200 bg-white shadow-sm transition hover:bg-stone-50 dark:border-stone-700 dark:bg-stone-900 dark:hover:bg-stone-800"
        aria-label="Toggle theme"
      >
        <img src="/sun.png" alt="" width={20} height={20} className={theme === "dark" ? "invert" : ""} />
      </button>

      <main className="min-h-screen bg-stone-100 text-stone-900 dark:bg-stone-950 dark:text-stone-50">
        <div className="mx-auto max-w-7xl px-6 py-10 md:px-10">
          <header className="mb-8 flex flex-col gap-6 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <p className="text-sm uppercase tracking-[0.3em] text-stone-500 dark:text-stone-400">ns-3 simulation</p>
              <h1 className="mt-3 text-3xl font-semibold">Fat-Tree Topology</h1>
            </div>

            <div className="w-fit rounded-2xl border border-stone-200 bg-white p-4 dark:border-stone-800 dark:bg-stone-900">
              <div className="flex items-center gap-3">
                <input value={linkRate} onChange={(e) => setLinkRate(e.target.value)}
                  className="h-11 w-40 rounded-xl border border-stone-300 bg-stone-50 px-3 text-sm text-stone-900 outline-none focus:border-stone-500 dark:border-stone-700 dark:bg-stone-950 dark:text-stone-100 dark:focus:border-stone-500"
                  placeholder="10Mbps" />
                <input value={linkDelay} onChange={(e) => setLinkDelay(e.target.value)}
                  className="h-11 w-32 rounded-xl border border-stone-300 bg-stone-50 px-3 text-sm text-stone-900 outline-none focus:border-stone-500 dark:border-stone-700 dark:bg-stone-950 dark:text-stone-100 dark:focus:border-stone-500"
                  placeholder="1ms" />
                <input value={k} onChange={(e) => setK(e.target.value)}
                  className="h-11 w-20 rounded-xl border border-stone-300 bg-stone-50 px-3 text-sm text-stone-900 outline-none focus:border-stone-500 dark:border-stone-700 dark:bg-stone-950 dark:text-stone-100 dark:focus:border-stone-500"
                  placeholder="k" />
                <button onClick={runSimulation} disabled={loading || Boolean(topology.error)}
                  className="h-11 rounded-xl bg-stone-900 px-4 text-sm font-medium text-stone-50 transition hover:bg-stone-700 disabled:opacity-60 dark:bg-stone-100 dark:text-stone-900 dark:hover:bg-stone-200">
                  {loading ? "Running..." : "Run"}
                </button>
              </div>

              {topology.error && <p className="mt-2 text-sm text-rose-600 dark:text-rose-400">{topology.error}</p>}
              {error && <p className="mt-2 text-sm text-rose-600 dark:text-rose-400">{error}</p>}
            </div>
          </header>

          <section className="relative overflow-visible rounded-2xl border border-stone-200 bg-white p-4 dark:border-stone-800 dark:bg-stone-900/40">
            <div className="mb-4 flex flex-wrap gap-4 text-xs text-stone-500 dark:text-stone-400">
              {(["core", "agg", "access", "host"] as Node["type"][]).map((t) => (
                <span key={t}>
                  <span className="mr-2 inline-block h-3 w-3 rounded-full border-2" style={{ borderColor: nodeStroke(t) }} />
                  {t === "access" ? "ToR" : t.charAt(0).toUpperCase() + t.slice(1)}
                </span>
              ))}
            </div>

            <div className="absolute right-4 top-4 flex items-center gap-2">
              {hasPackets && (
                <span className="font-mono text-xs text-stone-500 dark:text-stone-400">
                  {animTime.toFixed(3)}s / {simEndTime.toFixed(2)}s
                </span>
              )}
              <button
                onClick={toggleAnim}
                disabled={!hasPackets}
                className="h-8 px-3 text-xs"
              >
                {animating ? "⏸" : animTime > 0 && animTime >= simEndTime ? "↺" : "▶"}
              </button>
            </div>

            <div className="overflow-auto">
              <svg width={svgWidth} height={svgHeight} className="mx-auto block">
                {topology.links.map((link, i) => {
                  const from = nodeMap.get(link.from);
                  const to = nodeMap.get(link.to);
                  if (!from || !to) return null;

                  const csvIds = csvIdsForSvgLink(link.from, link.to, numericK, packets);
                  const depth = csvIds.reduce((s, id) => s + (linkQueueDepths[id] ?? 0), 0);
                  const capacityBytes = csvIds.length * queueCapacityBytes;
                  const ratio = hasPackets && capacityBytes > 0 ? depth / capacityBytes : 0;
                  const isBottleneck = ratio > 0.8;
                  const stroke = queueColor(ratio, lineStroke);
                  const strokeWidth = hasPackets && depth > 0 ? 1 + ratio * 2.5 : 1;

                  return (
                    <g key={`${link.from}-${link.to}-${i}`}>
                      <line x1={from.x} y1={from.y} x2={to.x} y2={to.y} stroke={stroke} strokeWidth={strokeWidth}>
                        {isBottleneck && (
                          <animate attributeName="stroke-opacity" values="1;0.3;1" dur="0.6s" repeatCount="indefinite" />
                        )}
                      </line>
                    </g>
                  );
                })}

                {packetDots.map((dot) => (
                  <circle key={dot.key} cx={dot.x} cy={dot.y} r={4} fill="rgb(210, 217, 255)" />
                ))}

                {selectedNodeId && (() => {
                  const fromNode = nodeMap.get(selectedNodeId);
                  if (!fromNode) return null;
                  const fromNumeric = svgIdToNumeric(selectedNodeId, numericK);
                  const neighbors = topology.links
                    .filter(l => l.from === selectedNodeId || l.to === selectedNodeId)
                    .map(l => l.from === selectedNodeId ? l.to : l.from);
                  return neighbors.map(neighborSvgId => {
                    const toNumeric = svgIdToNumeric(neighborSvgId, numericK);
                    const csvId = `${fromNumeric}-${toNumeric}`;
                    const toNode = nodeMap.get(neighborSvgId);
                    if (!toNode) return null;
                    const dx = toNode.x - fromNode.x;
                    const dy = toNode.y - fromNode.y;
                    const len = Math.sqrt(dx * dx + dy * dy);
                    const bx = fromNode.x + (dx / len) * 30;
                    const by = fromNode.y + (dy / len) * 30;
                    const isSelected = selectedQueueCsvId === csvId;
                    return (
                      <rect key={csvId}
                        x={bx - 7} y={by - 4} width={14} height={8} rx={2}
                        fill="rgb(220, 229, 124)"
                        stroke={isSelected ? "white" : "none"} strokeWidth={isSelected ? 1.5 : 0}
                        style={{ cursor: "pointer" }}
                        onClick={(e) => { e.stopPropagation(); setSelectedQueueCsvId(prev => prev === csvId ? null : csvId); }}
                      />
                    );
                  });
                })()}

                {topology.nodes.map((node) => {
                  const isHost = node.type === "host";
                  return (
                    <g key={node.id}
                      style={{ cursor: "pointer" }}
                      onClick={() => {
                        setSelectedNodeId(prev => prev === node.id ? null : node.id);
                        setSelectedQueueCsvId(null);
                      }}>
                      {isHost ? (
                        <rect x={node.x - 10} y={node.y - 8} width="20" height="16" rx="4"
                          fill={nodeFill} stroke={nodeStroke(node.type)} strokeWidth="2" />
                      ) : (
                        <circle cx={node.x} cy={node.y} r="16"
                          fill={nodeFill} stroke={nodeStroke(node.type)} strokeWidth="2" />
                      )}
                      <text x={node.x} y={node.y + 31} textAnchor="middle"
                        className="fill-stone-500 text-[10px] dark:fill-stone-400">
                        {node.label}
                      </text>
                    </g>
                  );
                })}
              </svg>
            </div>

            {selectedInfo && (
              <div className="mt-4 rounded-xl border border-stone-200 bg-stone-50 p-4 dark:border-stone-700 dark:bg-stone-900">
                <p className="truncate font-mono text-xs text-stone-500 dark:text-stone-400">{selectedInfo.label}</p>
                <div className="mt-3">
                  <div className="mb-1 flex justify-between text-xs text-stone-400">
                    <span>packet size / capacity</span>
                    <span>{selectedInfo.currentBytes} / {selectedInfo.capacityBytes} B</span>
                  </div>
                  <div className="h-2 w-full overflow-hidden rounded-full bg-stone-200 dark:bg-stone-700">
                    <div
                      className="h-full rounded-full transition-all duration-75"
                      style={{ width: `${Math.min(selectedInfo.ratio * 100, 100)}%`, backgroundColor: "rgb(220, 229, 124)" }}
                    />
                  </div>
                </div>
              </div>
            )}
          </section>

          {hasPackets && (
            <div className="mt-3 rounded-2xl border border-stone-200 bg-white px-4 py-3 dark:border-stone-800 dark:bg-stone-900/40">
              <div className="flex items-center gap-3">
                <div className="relative flex-1">
                  <input
                    type="range"
                    min={0}
                    max={simEndTime}
                    step={simEndTime / 4000}
                    value={animTime}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      setAnimating(false);
                      animStartSim.current = v;
                      setAnimTime(v);
                    }}
                    className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-stone-200 accent-stone-700 dark:bg-stone-700 dark:accent-stone-300"
                    style={{
                      background: `linear-gradient(to right, ${
                        theme === "dark" ? "rgb(214,211,209)" : "rgb(41,37,36)"
                      } ${(animTime / simEndTime) * 100}%, ${
                        theme === "dark" ? "rgb(68,64,60)" : "rgb(214,211,209)"
                      } ${(animTime / simEndTime) * 100}%)`,
                    }}
                  />
                </div>
              </div>
            </div>
          )}
        </div>
      </main>
    </>
  );
}
