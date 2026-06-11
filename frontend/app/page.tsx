"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { buildFatTree, nodeStroke, type Node } from "@/lib/topology";
import TopologyWizard, {
  deriveLinkConfig,
  getBottleneckLinkRate,
  parseLinkRateBps,
  type TopologyConfig,
} from "@/components/TopologyWizard";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace JSX {
    interface IntrinsicElements {
      [elemName: string]: unknown;
    }
  }
}

type PacketRow = {
  id: number;
  size: number;
  enqueue_time: number;
  dequeue_time: number;
  arrive_time: number;
};

type RunResult = { runTag: string; linkIds: string[] };
type RunStatus = {
  runTag: string;
  status: "queued" | "running" | "completed" | "failed";
  linkIds: string[];
  error?: string | null;
};

type Dot = { key: string; x: number; y: number };
type RenderTopology = { nodes: Node[]; links: { from: string; to: string }[]; error: string | null };
type QueueSelectionInfo = {
  csvId: string;
  label: string;
  currentBytes: number;
  capacityBytes: number;
  currentPackets: number;
  capacityPackets: number;
  ratio: number;
  points: { time: number; size: number; delay: number }[]; // size: queued bytes, delay: avg waiting delay(sec)
};
type QueueOverlay = {
  csvId: string;
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  markerX: number;
  markerY: number;
};

function sleep(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

const DATA_PACKET_BYTES = 1024;

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
    return `pod-${Math.floor(off / half)}-tor-${off % half}`;
  }
  if (num < numHosts + numTor + numAgg) {
    const off = num - numHosts - numTor;
    return `pod-${Math.floor(off / half)}-agg-${off % half}`;
  }
  return `core-${num - numHosts - numTor - numAgg}`;
}

// "12-34" -> [svgId, svgId]
function parseLinkSvgIds(linkId: string, resolveNumericNodeId: (num: number) => string): [string, string] | null {
  const parts = linkId.split("-");
  if (parts.length !== 2) return null;
  const from = parseInt(parts[0]);
  const to = parseInt(parts[1]);
  if (isNaN(from) || isNaN(to)) return null;
  return [resolveNumericNodeId(from), resolveNumericNodeId(to)];
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
  const acc = svgId.match(/^pod-(\d+)-tor-(\d+)$/);
  if (acc) return numHosts + Number(acc[1]) * half + Number(acc[2]);
  const host = svgId.match(/^pod-(\d+)-host-(\d+)-(\d+)$/);
  if (host) return Number(host[1]) * half * half + Number(host[2]) * half + Number(host[3]);
  return -1;
}

function csvIdsForSvgLink(
  svgFrom: string,
  svgTo: string,
  resolveSvgNodeId: (svgId: string) => number,
  packets: Record<string, PacketRow[]>
): string[] {
  const a = resolveSvgNodeId(svgFrom);
  const b = resolveSvgNodeId(svgTo);
  if (a < 0 || b < 0) return [];
  return [`${a}-${b}`, `${b}-${a}`].filter(id => id in packets);
}

function parseLinkDelaySeconds(linkDelay: string): number {
  const d = linkDelay.trim();
  if (d.endsWith("ms")) return parseFloat(d) * 1e-3;
  if (d.endsWith("us")) return parseFloat(d) * 1e-6;
  if (d.endsWith("ns")) return parseFloat(d) * 1e-9;
  return parseFloat(d);
}

function computeMaxRttSeconds(topology: RenderTopology, linkDelaySeconds: number): number {
  if (linkDelaySeconds <= 0 || topology.nodes.length === 0) return 0;

  const idToIndex = new Map<string, number>();
  topology.nodes.forEach((node, idx) => idToIndex.set(node.id, idx));
  const adj: number[][] = Array.from({ length: topology.nodes.length }, () => []);

  for (const link of topology.links) {
    const a = idToIndex.get(link.from);
    const b = idToIndex.get(link.to);
    if (a === undefined || b === undefined) continue;
    adj[a].push(b);
    adj[b].push(a);
  }

  const hostIndices = topology.nodes
    .map((node, idx) => ({ type: node.type, idx }))
    .filter((v) => v.type === "host")
    .map((v) => v.idx);

  if (hostIndices.length < 2) return 2 * linkDelaySeconds;

  let maxHops = 1;
  for (const src of hostIndices) {
    const dist = new Array<number>(topology.nodes.length).fill(-1);
    const queue: number[] = [src];
    dist[src] = 0;

    for (let head = 0; head < queue.length; head++) {
      const cur = queue[head];
      for (const nxt of adj[cur]) {
        if (dist[nxt] !== -1) continue;
        dist[nxt] = dist[cur] + 1;
        queue.push(nxt);
      }
    }

    for (const dst of hostIndices) {
      if (dst === src) continue;
      const hops = dist[dst];
      if (hops > maxHops) maxHops = hops;
    }
  }

  return 2 * maxHops * linkDelaySeconds;
}

function parseQueueCapacityBytes(linkRate: string, maxRttSeconds: number): number {
  const bps = parseLinkRateBps(linkRate);
  return Math.max(1, Math.floor(bps * maxRttSeconds / 8));
}

function queueColor(ratio: number, fallback: string): string {
  if (ratio > 0.8) return "rgb(42, 34, 255)";
  if (ratio > 0.6) return "rgb(72, 66, 229)";
  if (ratio > 0.5) return "rgb(97, 93, 217)";
  return fallback;
}

function buildSingleTorTopology(serversPerTor: number, startX: number): RenderTopology {
  const nodes: Node[] = [];
  const links: { from: string; to: string }[] = [];
  const torX = startX + 240;
  const torY = 220;
  nodes.push({ id: "tor-0", label: "ToR0", type: "tor", x: torX, y: torY });
  const count = Math.max(1, serversPerTor);
  for (let i = 0; i < count; i++) {
    const x = torX - ((count - 1) * 34) / 2 + i * 34;
    const id = `host-0-${i}`;
    nodes.push({ id, label: `H${i}`, type: "host", x, y: 380 });
    links.push({ from: id, to: "tor-0" });
  }
  return { nodes, links, error: null };
}

function buildTwoLayerTopology(torCount: number, aggCount: number, serversPerTor: number, startX: number): RenderTopology {
  const nodes: Node[] = [];
  const links: { from: string; to: string }[] = [];
  const tors = Math.max(1, torCount);
  const aggs = Math.max(1, aggCount);
  const spacing = 120;
  const baseX = startX + 80;

  for (let i = 0; i < aggs; i++) {
    nodes.push({ id: `agg-${i}`, label: `A${i}`, type: "agg", x: baseX + i * spacing, y: 140 });
  }
  for (let t = 0; t < tors; t++) {
    const torId = `tor-${t}`;
    nodes.push({ id: torId, label: `T${t}`, type: "tor", x: baseX + t * spacing, y: 260 });
    for (let a = 0; a < aggs; a++) links.push({ from: torId, to: `agg-${a}` });
    const hosts = Math.max(1, serversPerTor);
    for (let h = 0; h < hosts; h++) {
      const hx = baseX + t * spacing - ((hosts - 1) * 20) / 2 + h * 20;
      const hostId = `host-${t}-${h}`;
      nodes.push({ id: hostId, label: `H${t}.${h}`, type: "host", x: hx, y: 390 });
      links.push({ from: hostId, to: torId });
    }
  }
  return { nodes, links, error: null };
}



export default function Home() {
  const MAX_SELECTED_QUEUES = 4;
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [k, setK] = useState("4");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [runResult, setRunResult] = useState<RunResult | null>(null);
  const [runStatus, setRunStatus] = useState<RunStatus | null>(null);

  const [packets, setPackets] = useState<Record<string, PacketRow[]>>({});
  const [fetchingPackets, setFetchingPackets] = useState(false);

  const [animTime, setAnimTime] = useState(0);
  const [animating, setAnimating] = useState(false);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedQueueCsvIds, setSelectedQueueCsvIds] = useState<string[]>([]);
  const [focusedQueueCsvId, setFocusedQueueCsvId] = useState<string | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [topologyConfig, setTopologyConfig] = useState<TopologyConfig | null>(null);

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
  const svgHeight = 500;
  const startX = 80;
  const defaultConfig = useMemo<TopologyConfig>(() => {
    const topology = { type: "three_layer" as const, k: Number(k) };
    return {
      layers: 3,
      topology,
      link: deriveLinkConfig(3, topology, "10Mbps", 1, "1ms"),
      queue: {
        congestionAlgo: "TcpNewReno",
        queueAlgo: "FifoQueueDisc",
        redMinThresholdPct: 20,
        redMaxThresholdPct: 60,
      },
    };
  }, [k]);
  const appliedConfig = topologyConfig ?? defaultConfig;
  const topology = useMemo(() => {
    if (!topologyConfig) return buildFatTree(numericK, startX);
    if (topologyConfig.topology.type === "single_tor") {
      return buildSingleTorTopology(topologyConfig.topology.serversPerTor, startX);
    }
    if (topologyConfig.topology.type === "two_layer") {
      return buildTwoLayerTopology(
        topologyConfig.topology.torCount,
        topologyConfig.topology.aggCount,
        topologyConfig.topology.serversPerTor,
        startX
      );
    }
    return buildFatTree(topologyConfig.topology.k, startX);
  }, [topologyConfig, numericK, startX]);

  const svgWidth = useMemo(() => {
    if (!topology.nodes.length) return 900;
    const maxX = Math.max(...topology.nodes.map((n) => n.x));
    return Math.max(900, maxX + 120);
  }, [topology.nodes]);
  const nodeMap = useMemo(
    () => new Map(topology.nodes.map((n) => [n.id, n])),
    [topology.nodes]
  );
  const resolveNumericNodeId = useMemo(() => {
    return (num: number) => {
      if (topologyConfig?.topology.type === "single_tor") {
        const s = topologyConfig.topology.serversPerTor;
        if (num < s) return `host-0-${num}`;
        return "tor-0";
      }
      if (topologyConfig?.topology.type === "two_layer") {
        const s = topologyConfig.topology.serversPerTor;
        const t = topologyConfig.topology.torCount;
        const hosts = s * t;
        if (num < hosts) return `host-${Math.floor(num / s)}-${num % s}`;
        if (num < hosts + t) return `tor-${num - hosts}`;
        return `agg-${num - hosts - t}`;
      }
      return numericToSvgId(num, numericK);
    };
  }, [topologyConfig, numericK]);
  const resolveSvgNodeId = useMemo(() => {
    return (svgId: string) => {
      if (topologyConfig?.topology.type === "single_tor") {
        const host = svgId.match(/^host-0-(\d+)$/);
        if (host) return Number(host[1]);
        if (svgId === "tor-0") return topologyConfig.topology.serversPerTor;
        return -1;
      }
      if (topologyConfig?.topology.type === "two_layer") {
        const host = svgId.match(/^host-(\d+)-(\d+)$/);
        if (host) {
          return Number(host[1]) * topologyConfig.topology.serversPerTor + Number(host[2]);
        }
        const tor = svgId.match(/^tor-(\d+)$/);
        if (tor) {
          return topologyConfig.topology.torCount * topologyConfig.topology.serversPerTor + Number(tor[1]);
        }
        const agg = svgId.match(/^agg-(\d+)$/);
        if (agg) {
          return (
            topologyConfig.topology.torCount * topologyConfig.topology.serversPerTor +
            topologyConfig.topology.torCount +
            Number(agg[1])
          );
        }
        return -1;
      }
      return svgIdToNumeric(svgId, numericK);
    };
  }, [topologyConfig, numericK]);

  const lineStroke = theme === "dark" ? "rgb(68, 64, 60)" : "rgb(214, 211, 209)";
  const nodeFill = theme === "dark" ? "rgb(28, 25, 23)" : "rgb(255, 255, 255)";

  const simEndTime = useMemo(() => {
    let max = 0;
    for (const pkts of Object.values(packets))
      for (const p of pkts) if (p.arrive_time > max) max = p.arrive_time;
    return max > 0 ? max : 10;
  }, [packets]);

  const queueCapacityBytes = useMemo(
    () => {
      const delayS = parseLinkDelaySeconds(appliedConfig.link.delay);
      const maxRttSeconds = computeMaxRttSeconds(topology, delayS);
      return parseQueueCapacityBytes(getBottleneckLinkRate(appliedConfig), maxRttSeconds);
    },
    [appliedConfig, topology]
  );

  // per-frame: packet dots + current queue depths
  const { dots: packetDots, depths: linkQueueDepths } = useMemo(() => {
    const dots: Dot[] = [];
    const depths: Record<string, number> = {}; // link `string` -> current queue byte

    for (const [linkId, pkts] of Object.entries(packets)) {
      const ids = parseLinkSvgIds(linkId, resolveNumericNodeId);
      const fromNode = ids ? nodeMap.get(ids[0]) : null;
      const toNode = ids ? nodeMap.get(ids[1]) : null;
      let depth = 0;

      // Each directed link gets its own side of the shared physical link.
      let perpX = 0;
      let perpY = 0;
      if (fromNode && toNode) {
        const parts = linkId.split("-");
        const fromNum = parseInt(parts[0]);
        const toNum = parseInt(parts[1]);
        const isForwardOnCanonicalLink = fromNum < toNum;
        const canonicalFrom = isForwardOnCanonicalLink ? fromNode : toNode;
        const canonicalTo = isForwardOnCanonicalLink ? toNode : fromNode;
        const dx = canonicalTo.x - canonicalFrom.x;
        const dy = canonicalTo.y - canonicalFrom.y;
        const len = Math.sqrt(dx * dx + dy * dy);
        if (len > 0) {
          const offsetSign = isForwardOnCanonicalLink ? 1 : -1;
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
  }, [animTime, packets, nodeMap, resolveNumericNodeId]);

  const hasPackets = Object.keys(packets).length > 0;

  const selectedInfos = useMemo<QueueSelectionInfo[]>(() => {
    return selectedQueueCsvIds.map((csvId) => {
      const pkts = packets[csvId] ?? [];
      const parts = csvId.split("-");
      const fromLabel = nodeMap.get(resolveNumericNodeId(parseInt(parts[0])))?.label ?? parts[0];
      const toLabel = nodeMap.get(resolveNumericNodeId(parseInt(parts[1])))?.label ?? parts[1];
      const queuedNow = pkts.filter((p) => p.enqueue_time <= animTime && p.dequeue_time >= animTime);
      const currentBytes = queuedNow.reduce((s, p) => s + p.size, 0);
      const currentPackets = queuedNow.length;
      const capacityPackets = Math.max(1, Math.floor(queueCapacityBytes / DATA_PACKET_BYTES));
      const ratio = queueCapacityBytes > 0 ? currentBytes / queueCapacityBytes : 0;
      const sampleCount = 180;
      const maxTime = simEndTime > 0 ? simEndTime : 1;
      const points = Array.from({ length: sampleCount + 1 }, (_, i) => {
        const t = (i / sampleCount) * maxTime;
        let queuedBytes = 0;
        let waitSum = 0;
        let count = 0;
        for (const p of pkts) {
          if (p.enqueue_time <= t && p.dequeue_time >= t) {
            queuedBytes += p.size;
            waitSum += Math.max(0, t - p.enqueue_time);
            count += 1;
          }
        }
        const avgWaitingDelay = count > 0 ? waitSum / count : 0;
        return { time: t, size: queuedBytes, delay: avgWaitingDelay };
      });
      return {
        csvId,
        label: `${fromLabel} → ${toLabel}`,
        currentBytes,
        capacityBytes: queueCapacityBytes,
        currentPackets,
        capacityPackets,
        ratio,
        points,
      };
    });
  }, [selectedQueueCsvIds, packets, animTime, queueCapacityBytes, nodeMap, resolveNumericNodeId, simEndTime]);

  const selectedQueueOverlays = useMemo<QueueOverlay[]>(() => {
    const overlays: QueueOverlay[] = [];
    for (const csvId of selectedQueueCsvIds) {
      const [fromText, toText] = csvId.split("-");
      const fromNum = parseInt(fromText);
      const toNum = parseInt(toText);
      if (Number.isNaN(fromNum) || Number.isNaN(toNum)) continue;
      const fromSvg = resolveNumericNodeId(fromNum);
      const toSvg = resolveNumericNodeId(toNum);
      const fromNode = nodeMap.get(fromSvg);
      const toNode = nodeMap.get(toSvg);
      if (!fromNode || !toNode) continue;
      const dx = toNode.x - fromNode.x;
      const dy = toNode.y - fromNode.y;
      const len = Math.sqrt(dx * dx + dy * dy);
      const offset = 16;
      const markerX = len > 0 ? fromNode.x + (dx / len) * offset : fromNode.x;
      const markerY = len > 0 ? fromNode.y + (dy / len) * offset : fromNode.y;
      overlays.push({
        csvId,
        fromX: fromNode.x,
        fromY: fromNode.y,
        toX: toNode.x,
        toY: toNode.y,
        markerX,
        markerY,
      });
    }
    return overlays;
  }, [selectedQueueCsvIds, resolveNumericNodeId, nodeMap]);

  useEffect(() => {
    if (!animating) {
      if (animRaf.current !== null) { cancelAnimationFrame(animRaf.current); animRaf.current = null; }
      return;
    }
    const wallStart = performance.now();
    const simStart = animStartSim.current;
    function frame() {
      const sim = simStart + (performance.now() - wallStart) / (1000 * 60);
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

  async function fetchPacketsForRun(data: RunResult) {
    setRunResult(data);
    setFetchingPackets(true);
    const fetched: Record<string, PacketRow[]> = {};
    await Promise.all(
      data.linkIds.map(async (linkId) => {
        const r = await fetch(`/results/${data.runTag}/link/${linkId}`);
        if (r.ok) {
          const d = await r.json();
          fetched[linkId] = d.packets;
        }
      })
    );
    setPackets(fetched);
  }

  async function maybeRequestNotificationPermission() {
    if (typeof window === "undefined" || !("Notification" in window)) return "denied";
    if (Notification.permission !== "default") return Notification.permission;
    return Notification.requestPermission();
  }

  function notifyRunFinished(status: RunStatus) {
    if (typeof window === "undefined" || !("Notification" in window)) return;
    if (Notification.permission !== "granted") return;

    if (status.status === "completed") {
      new Notification("ns-3 simulation complete", {
        body: `${status.runTag} finished and results are ready.`,
      });
      return;
    }

    if (status.status === "failed") {
      new Notification("ns-3 simulation failed", {
        body: status.error ?? `${status.runTag} failed.`,
      });
    }
  }

  async function runSimulation() {
    // initialize exisiting output
    setLoading(true);
    setError(null);
    setRunResult(null);
    setRunStatus(null);
    setPackets({});
    setAnimating(false);
    setAnimTime(0);
    setSelectedNodeId(null);
    setSelectedQueueCsvIds([]);
    setFocusedQueueCsvId(null);

    try {
      const runPayload = (() => {
        if (!topologyConfig) {
          return {
            layers: 3,
            k: Number(k),
            torCount: 2,
            aggCount: 2,
            serversPerTor: 8,
            linkRate: defaultConfig.link.serverToTorRate,
            serverToTorRate: defaultConfig.link.serverToTorRate,
            torToAggRate: defaultConfig.link.torToAggRate,
            aggToCoreRate: defaultConfig.link.aggToCoreRate,
            linkDelay: defaultConfig.link.delay,
            tcp: defaultConfig.queue.congestionAlgo,
            queue: defaultConfig.queue.queueAlgo,
            redMinThresholdPct: defaultConfig.queue.redMinThresholdPct,
            redMaxThresholdPct: defaultConfig.queue.redMaxThresholdPct,
          };
        }
        if (topologyConfig.topology.type === "single_tor") {
          return {
            layers: 1,
            k: Number(k),
            torCount: 1,
            aggCount: 0,
            serversPerTor: topologyConfig.topology.serversPerTor,
            linkRate: topologyConfig.link.serverToTorRate,
            serverToTorRate: topologyConfig.link.serverToTorRate,
            torToAggRate: topologyConfig.link.torToAggRate,
            aggToCoreRate: topologyConfig.link.aggToCoreRate,
            linkDelay: topologyConfig.link.delay,
            tcp: topologyConfig.queue.congestionAlgo,
            queue: topologyConfig.queue.queueAlgo,
            redMinThresholdPct: topologyConfig.queue.redMinThresholdPct,
            redMaxThresholdPct: topologyConfig.queue.redMaxThresholdPct,
          };
        }
        if (topologyConfig.topology.type === "two_layer") {
          return {
            layers: 2,
            k: Number(k),
            torCount: topologyConfig.topology.torCount,
            aggCount: topologyConfig.topology.aggCount,
            serversPerTor: topologyConfig.topology.serversPerTor,
            linkRate: topologyConfig.link.serverToTorRate,
            serverToTorRate: topologyConfig.link.serverToTorRate,
            torToAggRate: topologyConfig.link.torToAggRate,
            aggToCoreRate: topologyConfig.link.aggToCoreRate,
            linkDelay: topologyConfig.link.delay,
            tcp: topologyConfig.queue.congestionAlgo,
            queue: topologyConfig.queue.queueAlgo,
            redMinThresholdPct: topologyConfig.queue.redMinThresholdPct,
            redMaxThresholdPct: topologyConfig.queue.redMaxThresholdPct,
          };
        }
        return {
          layers: 3,
          k: topologyConfig.topology.k,
          torCount: 2,
          aggCount: 2,
          serversPerTor: 8,
          linkRate: topologyConfig.link.serverToTorRate,
          serverToTorRate: topologyConfig.link.serverToTorRate,
          torToAggRate: topologyConfig.link.torToAggRate,
          aggToCoreRate: topologyConfig.link.aggToCoreRate,
          linkDelay: topologyConfig.link.delay,
          tcp: topologyConfig.queue.congestionAlgo,
          queue: topologyConfig.queue.queueAlgo,
          redMinThresholdPct: topologyConfig.queue.redMinThresholdPct,
          redMaxThresholdPct: topologyConfig.queue.redMaxThresholdPct,
        };
      })();

      const res = await fetch("/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(runPayload),
      });
      if (!res.ok) throw new Error(`Backend Error: ${res.status}`);
      const initialStatus: RunStatus = await res.json();
      setRunStatus(initialStatus);

      void maybeRequestNotificationPermission();

      let latestStatus = initialStatus;
      while (latestStatus.status === "queued" || latestStatus.status === "running") {
        await sleep(1500);
        const statusRes = await fetch(`/runs/${latestStatus.runTag}/status`, { cache: "no-store" });
        if (!statusRes.ok) throw new Error(`Backend Error: ${statusRes.status}`);
        latestStatus = await statusRes.json();
        setRunStatus(latestStatus);
      }

      notifyRunFinished(latestStatus);

      if (latestStatus.status === "failed") {
        throw new Error(latestStatus.error ?? "Simulation failed");
      }

      await fetchPacketsForRun({
        runTag: latestStatus.runTag,
        linkIds: latestStatus.linkIds,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
      setFetchingPackets(false);
    }
  }

  function applyWizardConfig(config: TopologyConfig) {
    setTopologyConfig(config);
    if (config.topology.type === "three_layer") {
      setK(String(config.topology.k));
    }
    setWizardOpen(false);
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
              <div className="flex items-center justify-between gap-1">
                <div className="mt-3 flex flex-wrap gap-1 text-xs">
                <span className="rounded-full bg-stone-100 px-3 py-1 dark:bg-stone-800">{appliedConfig.layers}-layer</span>
                {appliedConfig.topology.type === "three_layer" && (
                  <span className="rounded-full bg-stone-100 px-3 py-1 dark:bg-stone-800">{appliedConfig.topology.k} pods</span>
                )}
                {appliedConfig.topology.type === "two_layer" && (
                  <>
                    <span className="rounded-full bg-stone-100 px-3 py-1 dark:bg-stone-800">{appliedConfig.topology.torCount} ToRs</span>
                    <span className="rounded-full bg-stone-100 px-3 py-1 dark:bg-stone-800">{appliedConfig.topology.aggCount} Aggs</span>
                    <span className="rounded-full bg-stone-100 px-3 py-1 dark:bg-stone-800">{appliedConfig.topology.serversPerTor} servers/ToR</span>
                  </>
                )}
                {appliedConfig.topology.type === "single_tor" && (
                  <span className="rounded-full bg-stone-100 px-3 py-1 dark:bg-stone-800">{appliedConfig.topology.serversPerTor} servers/ToR</span>
                )}
                <span className="rounded-full bg-stone-100 px-3 py-1 dark:bg-stone-800">S-ToR: {appliedConfig.link.serverToTorRate}</span>
                {appliedConfig.layers >= 2 && (
                  <>
                    <span className="rounded-full bg-stone-100 px-3 py-1 dark:bg-stone-800">ToR OS: {appliedConfig.link.torOversubRatio}:1</span>
                    <span className="rounded-full bg-stone-100 px-3 py-1 dark:bg-stone-800">ToR-Agg: {appliedConfig.link.torToAggRate}</span>
                  </>
                )}
                {appliedConfig.layers >= 3 && (
                  <span className="rounded-full bg-stone-100 px-3 py-1 dark:bg-stone-800">Agg-Core: {appliedConfig.link.aggToCoreRate}</span>
                )}
                <span className="rounded-full bg-stone-100 px-3 py-1 dark:bg-stone-800">Delay: {appliedConfig.link.delay}</span>
                <span className="rounded-full bg-stone-100 px-3 py-1 dark:bg-stone-800">{appliedConfig.queue.congestionAlgo}</span>
                <span className="rounded-full bg-stone-100 px-3 py-1 dark:bg-stone-800">{appliedConfig.queue.queueAlgo}</span>
                {appliedConfig.queue.queueAlgo === "RedQueueDisc" && (
                  <>
                    <span className="rounded-full bg-stone-100 px-3 py-1 dark:bg-stone-800">
                      RED min: {appliedConfig.queue.redMinThresholdPct}%
                    </span>
                    <span className="rounded-full bg-stone-100 px-3 py-1 dark:bg-stone-800">
                      RED max: {appliedConfig.queue.redMaxThresholdPct}%
                    </span>
                  </>
                )}
              </div>
                <button
                  type="button"
                  onClick={() => setWizardOpen(true)}
                  className="h-9 rounded-xl bg-stone-900 px-4 mr-2 text-sm font-medium text-stone-50 transition hover:bg-stone-700 disabled:opacity-60 dark:bg-stone-100 dark:text-stone-900 dark:hover:bg-stone-200"
                >
                  Configure
                </button>
                <button onClick={runSimulation} disabled={loading || Boolean(topology.error)}
                  className="h-9 rounded-xl bg-stone-900 px-4 text-sm font-medium text-stone-50 transition hover:bg-stone-700 disabled:opacity-60 dark:bg-stone-100 dark:text-stone-900 dark:hover:bg-stone-200">
                  {loading ? "Running..." : "Run"}
                </button>
              </div>

              {runStatus && (
                <p className="mt-2 text-sm text-stone-500 dark:text-stone-400">
                  Status: {runStatus.status}
                  {runStatus.status !== "completed" ? ` (${runStatus.runTag})` : ""}
                </p>
              )}
              {runResult && <p className="mt-2 text-sm text-stone-500 dark:text-stone-400">Latest run: {runResult.runTag}</p>}
              {fetchingPackets && <p className="mt-2 text-sm text-stone-500 dark:text-stone-400">Loading simulation results...</p>}
              {topology.error && <p className="mt-2 text-sm text-rose-600 dark:text-rose-400">{topology.error}</p>}
              {error && <p className="mt-2 text-sm text-rose-600 dark:text-rose-400">{error}</p>}
            </div>
          </header>

          <section className="relative overflow-visible rounded-2xl border border-stone-200 bg-white p-4 dark:border-stone-800 dark:bg-stone-900/40">
            <div className="mb-4 flex flex-wrap gap-4 text-xs text-stone-500 dark:text-stone-400">
              {(["core", "agg", "tor", "host"] as Node["type"][]).map((t) => (
                <span key={t}>
                  <span className="mr-2 inline-block h-3 w-3 rounded-full border-2" style={{ borderColor: nodeStroke(t) }} />
                  {t === "tor" ? "ToR" : t.charAt(0).toUpperCase() + t.slice(1)}
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

                  const csvIds = csvIdsForSvgLink(link.from, link.to, resolveSvgNodeId, packets);
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

                {selectedQueueOverlays.map((q) => {
                  const isFocused = focusedQueueCsvId === q.csvId;
                  return (
                    <g key={`overlay-${q.csvId}`} style={{ cursor: "pointer" }} onClick={() => setFocusedQueueCsvId(q.csvId)}>
                      <line
                        x1={q.fromX}
                        y1={q.fromY}
                        x2={q.toX}
                        y2={q.toY}
                        stroke="rgb(220, 229, 124)"
                        strokeWidth={isFocused ? 3.5 : 2}
                        strokeDasharray={isFocused ? "0" : "4 3"}
                        strokeOpacity={0.95}
                      />
                      <rect
                        x={q.markerX - 7}
                        y={q.markerY - 5}
                        width={14}
                        height={10}
                        rx={2}
                        fill={isFocused ? "rgb(220, 229, 124)" : "white"}
                        strokeWidth={isFocused ? 2 : 1}
                      />
                    </g>
                  );
                })}

                {selectedNodeId && (() => {
                  const fromNode = nodeMap.get(selectedNodeId);
                  if (!fromNode) return null;
                  const fromNumeric = resolveSvgNodeId(selectedNodeId);
                  const neighbors = topology.links
                    .filter(l => l.from === selectedNodeId || l.to === selectedNodeId)
                    .map(l => l.from === selectedNodeId ? l.to : l.from);
                  return neighbors.map(neighborSvgId => {
                    const toNumeric = resolveSvgNodeId(neighborSvgId);
                    const csvId = `${fromNumeric}-${toNumeric}`;
                    const toNode = nodeMap.get(neighborSvgId);
                    if (!toNode) return null;
                    const dx = toNode.x - fromNode.x;
                    const dy = toNode.y - fromNode.y;
                    const len = Math.sqrt(dx * dx + dy * dy);
                    const bx = fromNode.x + (dx / len) * 30;
                    const by = fromNode.y + (dy / len) * 30;
                    const isSelected = selectedQueueCsvIds.includes(csvId);
                    return (
                      <rect key={csvId}
                        x={bx - 7} y={by - 4} width={14} height={8} rx={2}
                        fill="white"
                        stroke={isSelected ? "white" : "none"} strokeWidth={isSelected ? 1.5 : 0}
                        style={{ cursor: "pointer" }}
                        onClick={(e) => {
                          e.stopPropagation();
                          setSelectedQueueCsvIds((prev) => {
                            if (prev.includes(csvId)) {
                              if (focusedQueueCsvId === csvId) setFocusedQueueCsvId(null);
                              return prev.filter((id) => id !== csvId);
                            }
                            const next = [...prev, csvId];
                            setFocusedQueueCsvId(csvId);
                            if (next.length <= MAX_SELECTED_QUEUES) return next;
                            return next.slice(next.length - MAX_SELECTED_QUEUES);
                          });
                        }}
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

            {selectedInfos.length > 0 && (
              <div className="mt-4 overflow-x-auto">
                <div className="flex min-w-full gap-3">
                  {selectedInfos.map((info) => {
                    const width = 280;
                    const height = 120;
                    const pad = 16;
                    const innerW = width - pad * 2;
                    const innerH = height - pad * 2;
                    const maxTime = simEndTime > 0 ? simEndTime : 1;
                    const maxSize = Math.max(1, ...info.points.map((p) => p.size));
                    const maxDelay = Math.max(1e-6, ...info.points.map((p) => p.delay));
                    const sizePath = info.points
                      .map((p, idx) => {
                        const x = pad + (p.time / maxTime) * innerW;
                        const y = pad + innerH - (p.size / maxSize) * innerH;
                        return `${idx === 0 ? "M" : "L"}${x.toFixed(2)} ${y.toFixed(2)}`;
                      })
                      .join(" ");
                    const delayPath = info.points
                      .map((p, idx) => {
                        const x = pad + (p.time / maxTime) * innerW;
                        const y = pad + innerH - (p.delay / maxDelay) * innerH;
                        return `${idx === 0 ? "M" : "L"}${x.toFixed(2)} ${y.toFixed(2)}`;
                      })
                      .join(" ");
                    const currentX = pad + (Math.min(animTime, simEndTime) / maxTime) * innerW;

                    return (
                      <div
                        key={info.csvId}
                        className={`w-[300px] shrink-0 rounded-xl border bg-stone-50 p-4 dark:bg-stone-900`}
                        style={{
                          cursor: "pointer",
                          borderColor: focusedQueueCsvId === info.csvId ? "rgb(220, 229, 124)" : undefined,
                        }}
                        onClick={() => setFocusedQueueCsvId(info.csvId)}
                      >
                        <p className="truncate font-mono text-xs text-stone-500 dark:text-stone-400">{info.label}</p>
                        <div className="mt-2 inline-flex items-baseline gap-x-1 text-xs text-stone-400" style={{ fontVariantNumeric: "tabular-nums" }}>
                          <span className="text-right" style={{ width: "5ch" }}>
                            {info.currentBytes}
                          </span>
                          <span>/</span>
                          <span className="text-right" style={{ width: "5ch" }}>
                            {info.capacityBytes}
                          </span>
                          <span>B</span>
                          <span>(</span>
                          <span className="text-right" style={{ width: "5ch" }}>
                            {info.currentPackets}/{info.capacityPackets}
                          </span>
                          <span>pkts)</span>
                        </div>
                        <svg width={width} height={height} className="mt-3 block rounded border border-stone-200 bg-white dark:border-stone-700 dark:bg-stone-950">
                          <line x1={pad} y1={height - pad} x2={width - pad} y2={height - pad} stroke="rgb(148, 163, 184)" strokeWidth={1} />
                          <line x1={pad} y1={pad} x2={pad} y2={height - pad} stroke="rgb(148, 163, 184)" strokeWidth={1} />
                          {info.points.length > 0 && (
                            <>
                              <path d={sizePath} fill="none" stroke="rgb(59, 130, 246)" strokeWidth={1.5} />
                              <path d={delayPath} fill="none" stroke="rgb(249, 115, 22)" strokeWidth={1.5} />
                            </>
                          )}
                          <line x1={currentX} y1={pad} x2={currentX} y2={height - pad} stroke="rgb(220, 229, 124)" strokeWidth={1} />
                        </svg>
                        <div className="mt-2 flex gap-3 text-[11px] text-stone-500 dark:text-stone-400">
                          <span>blue: queued size (B)</span>
                          <span>orange: avg wait delay (s)</span>
                        </div>
                      </div>
                    );
                  })}
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

      {wizardOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="max-h-[90vh] w-full max-w-3xl overflow-auto rounded-2xl bg-white p-4 shadow-xl dark:bg-stone-950">
            <div className="mb-3 flex items-center justify-between">
              <div />
              <button
                type="button"
                onClick={() => setWizardOpen(false)}
                aria-label="Close topology wizard"
                className="text-lg leading-none text-stone-700 hover:text-stone-900 dark:text-stone-200 dark:hover:text-white"
              >
                ×
              </button>
            </div>

            <TopologyWizard onSubmit={applyWizardConfig} />
          </div>
        </div>
      )}
    </>
  );
}
