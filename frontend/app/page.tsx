"use client";

import Image from "next/image";
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
type LinkAnimationData = {
  dequeueEvents: PacketRow[];
  enqueueEvents: PacketRow[];
  fromNode: Node;
  inFlightEndEvents: PacketRow[];
  inFlightStartEvents: PacketRow[];
  perpX: number;
  perpY: number;
  toNode: Node;
};
type LinkAnimationCursor = {
  activeInFlight: PacketRow[];
  dequeueIdx: number;
  depth: number;
  enqueueIdx: number;
  inFlightEndIdx: number;
  inFlightStartIdx: number;
};
type QueuePoint = {
  time: number;
  size: number;
  delay: number;
};
type QueueSnapshot = {
  time: number;
  bytes: number;
  enqueueTimeSum: number;
  packets: number;
};
type QueueSeries = {
  points: QueuePoint[];
  snapshots: QueueSnapshot[];
};
type RenderTopology = { nodes: Node[]; links: { from: string; to: string }[]; error: string | null };
type QueueSelectionInfo = {
  csvId: string;
  label: string;
  startTime: number;
  currentBytes: number;
  capacityBytes: number;
  currentDelay: number;
  currentPackets: number;
  capacityPackets: number;
  ratio: number;
  redMinBytes: number | null;
  redMaxBytes: number | null;
  maxDelay: number;
  maxSize: number;
  points: QueuePoint[]; // size: queued bytes, delay: avg waiting delay(sec)
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

function centerTopology(topology: RenderTopology, minWidth = 900, horizontalPadding = 120) {
  if (!topology.nodes.length) {
    return { topology, width: minWidth };
  }

  const minX = Math.min(...topology.nodes.map((node) => node.x));
  const maxX = Math.max(...topology.nodes.map((node) => node.x));
  const contentWidth = maxX - minX;
  const width = Math.max(minWidth, contentWidth + horizontalPadding * 2);
  const offsetX = (width - contentWidth) / 2 - minX;

  return {
    width,
    topology: {
      ...topology,
      nodes: topology.nodes.map((node) => ({ ...node, x: node.x + offsetX })),
    },
  };
}

function nodeFill(theme: "dark" | "light") {
  return theme === "dark" ? "rgb(28, 25, 23)" : "rgb(255, 255, 255)";
}

function sleep(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function parsePacketCsv(csvText: string): PacketRow[] {
  const rows = csvText.trim().split("\n");
  if (rows.length <= 1) return [];

  const packets: PacketRow[] = [];
  for (const row of rows.slice(1)) {
    if (!row.trim()) continue;
    const [id, size, enqueue_time, dequeue_time, arrive_time] = row.split(",");
    const parsedId = Number(id);
    const parsedSize = Number(size);
    const parsedEnqueue = Number(enqueue_time);
    const parsedDequeue = Number(dequeue_time);
    const parsedArrive = Number(arrive_time);

    if (
      Number.isNaN(parsedId) ||
      Number.isNaN(parsedSize) ||
      Number.isNaN(parsedEnqueue) ||
      Number.isNaN(parsedDequeue) ||
      Number.isNaN(parsedArrive)
    ) {
      continue;
    }

    packets.push({
      id: parsedId,
      size: parsedSize,
      enqueue_time: parsedEnqueue / 1e9,
      dequeue_time: parsedDequeue / 1e9,
      arrive_time: parsedArrive / 1e9,
    });
  }

  return packets;
}

function delayUnitScale(delaySeconds: number) {
  const magnitude = Math.max(Math.abs(delaySeconds), 1e-12);
  if (magnitude >= 1) return { unit: "s", scale: 1 };
  if (magnitude >= 1e-3) return { unit: "ms", scale: 1e3 };
  if (magnitude >= 1e-6) return { unit: "us", scale: 1e6 };
  return { unit: "ns", scale: 1e9 };
}

function formatDelay(delaySeconds: number) {
  const { unit, scale } = delayUnitScale(delaySeconds);
  const value = delaySeconds * scale;
  return `${value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2)} ${unit}`;
}

function averageDelayAtTime(time: number, packets: number, enqueueTimeSum: number) {
  return packets > 0 ? Math.max(0, time - enqueueTimeSum / packets) : 0;
}

function findLastSnapshotAtOrBeforeTime(snapshots: QueueSnapshot[], time: number) {
  let lo = 0;
  let hi = snapshots.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (snapshots[mid].time <= time) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return snapshots[Math.max(0, lo - 1)];
}

function lowerBoundQueuePoint(points: QueuePoint[], time: number) {
  let lo = 0;
  let hi = points.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (points[mid].time < time) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

function upperBoundQueuePoint(points: QueuePoint[], time: number) {
  let lo = 0;
  let hi = points.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (points[mid].time <= time) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

function buildQueueSeries(pkts: PacketRow[], maxTime: number): QueueSeries {
  if (pkts.length === 0) {
    return {
      points: [{ time: 0, size: 0, delay: 0 }, { time: maxTime, size: 0, delay: 0 }],
      snapshots: [{ time: 0, bytes: 0, enqueueTimeSum: 0, packets: 0 }],
    };
  }

  const events: Array<{ time: number; deltaBytes: number; deltaEnqueueTimeSum: number; deltaPackets: number }> = [];
  for (const p of pkts) {
    events.push({
      time: p.enqueue_time,
      deltaBytes: p.size,
      deltaEnqueueTimeSum: p.enqueue_time,
      deltaPackets: 1,
    });
    events.push({
      time: p.dequeue_time,
      deltaBytes: -p.size,
      deltaEnqueueTimeSum: -p.enqueue_time,
      deltaPackets: -1,
    });
  }
  events.sort((a, b) => a.time - b.time);

  let bytes = 0;
  let packets = 0;
  let enqueueTimeSum = 0;
  let idx = 0;

  const points: QueuePoint[] = [{ time: 0, size: 0, delay: 0 }];
  const snapshots: QueueSnapshot[] = [{ time: 0, bytes: 0, enqueueTimeSum: 0, packets: 0 }];

  while (idx < events.length) {
    const time = events[idx].time;
    if (time > maxTime) break;

    points.push({
      time,
      size: bytes,
      delay: averageDelayAtTime(time, packets, enqueueTimeSum),
    });

    let deltaBytes = 0;
    let deltaPackets = 0;
    let deltaEnqueueTimeSum = 0;
    while (idx < events.length && events[idx].time === time) {
      deltaBytes += events[idx].deltaBytes;
      deltaPackets += events[idx].deltaPackets;
      deltaEnqueueTimeSum += events[idx].deltaEnqueueTimeSum;
      idx += 1;
    }

    bytes = Math.max(0, bytes + deltaBytes);
    packets = Math.max(0, packets + deltaPackets);
    enqueueTimeSum += deltaEnqueueTimeSum;

    const delay = averageDelayAtTime(time, packets, enqueueTimeSum);
    points.push({ time, size: bytes, delay });
    snapshots.push({ time, bytes, enqueueTimeSum, packets });
  }

  const finalSnapshot = snapshots[snapshots.length - 1];
  if (points[points.length - 1]?.time !== maxTime) {
    points.push({
      time: maxTime,
      size: finalSnapshot.bytes,
      delay: averageDelayAtTime(maxTime, finalSnapshot.packets, finalSnapshot.enqueueTimeSum),
    });
  }

  return { points, snapshots };
}

function sampleQueuePoints(points: QueuePoint[], startTime: number, endTime: number, maxPoints = 400) {
  if (points.length === 0 || endTime < startTime) return [] as QueuePoint[];

  const startIdx = Math.max(0, lowerBoundQueuePoint(points, startTime) - 1);
  const endExclusive = upperBoundQueuePoint(points, endTime);
  const relevant = points.slice(startIdx, endExclusive);
  if (relevant.length <= maxPoints) return relevant;

  const sampled: QueuePoint[] = [];
  const stride = Math.ceil(relevant.length / maxPoints);
  for (let i = 0; i < relevant.length; i += stride) {
    sampled.push(relevant[i]);
  }
  const lastPoint = relevant[relevant.length - 1];
  if (sampled[sampled.length - 1] !== lastPoint) {
    sampled.push(lastPoint);
  }
  return sampled;
}

const DATA_PACKET_BYTES = 1024;
const QUEUE_MARKER_OFFSET = 25;
const MAX_PACKET_DOTS_PER_LINK = 64;

function queueMarkerPosition(fromNode: Node, toNode: Node, offset = QUEUE_MARKER_OFFSET) {
  const dx = toNode.x - fromNode.x;
  const dy = toNode.y - fromNode.y;
  const len = Math.sqrt(dx * dx + dy * dy);

  return {
    x: len > 0 ? fromNode.x + (dx / len) * offset : fromNode.x,
    y: len > 0 ? fromNode.y + (dy / len) * offset : fromNode.y,
  };
}

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
  if (d.endsWith("s") && !d.endsWith("ms") && !d.endsWith("us") && !d.endsWith("ns")) return parseFloat(d);
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
  const hostGap = 44;
  for (let i = 0; i < count; i++) {
    const x = torX - ((count - 1) * hostGap) / 2 + i * hostGap;
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
  const hosts = Math.max(1, serversPerTor);
  const hostGap = 28;
  const torSpan = Math.max(160, (hosts - 1) * hostGap + 56);
  const spacing = torSpan;
  const baseX = startX + 80;
  const torWidth = (tors - 1) * spacing;

  for (let i = 0; i < aggs; i++) {
    const aggX = aggs === 1
      ? baseX + torWidth / 2
      : baseX + ((i + 0.5) * torWidth) / aggs;
    nodes.push({ id: `agg-${i}`, label: `A${i}`, type: "agg", x: aggX, y: 140 });
  }
  for (let t = 0; t < tors; t++) {
    const torId = `tor-${t}`;
    nodes.push({ id: torId, label: `T${t}`, type: "tor", x: baseX + t * spacing, y: 260 });
    for (let a = 0; a < aggs; a++) links.push({ from: torId, to: `agg-${a}` });
    for (let h = 0; h < hosts; h++) {
      const hx = baseX + t * spacing - ((hosts - 1) * hostGap) / 2 + h * hostGap;
      const hostId = `host-${t}-${h}`;
      nodes.push({ id: hostId, label: `H${t}.${h}`, type: "host", x: hx, y: 390 });
      links.push({ from: hostId, to: torId });
    }
  }
  return { nodes, links, error: null };
}



export default function Home() {
  const MAX_SELECTED_QUEUES = 4;
  const playbackRates = [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1];
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [k, setK] = useState("4");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [packets, setPackets] = useState<Record<string, PacketRow[]>>({});

  const [animTime, setAnimTime] = useState(0);
  const [animating, setAnimating] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(0.5);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedQueueCsvIds, setSelectedQueueCsvIds] = useState<string[]>([]);
  const [selectedQueueStartTimes, setSelectedQueueStartTimes] = useState<Record<string, number>>({});
  const [focusedQueueCsvId, setFocusedQueueCsvId] = useState<string | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [topologyConfig, setTopologyConfig] = useState<TopologyConfig | null>(null);
  const animRaf = useRef<number | null>(null);
  const animStartSim = useRef(0);
  const animationCursorRef = useRef<{
    cursors: Record<string, LinkAnimationCursor>;
    time: number;
  } | null>(null);

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
      link: deriveLinkConfig(3, topology, "10Gbps", 1, "1ms"),
      queue: {
        congestionAlgo: "TcpNewReno",
        queueAlgo: "FifoQueueDisc",
        redMinThresholdPct: 20,
        redMaxThresholdPct: 60,
      },
      traffic: {
        loadPct: 50,
        workload: "Google_AllRPC",
      },
    };
  }, [k]);
  const appliedConfig = topologyConfig ?? defaultConfig;
  const rawTopology = useMemo(() => {
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

  const { topology, width: svgWidth } = useMemo(
    () => centerTopology(rawTopology),
    [rawTopology]
  );
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

  const linkAnimationData = useMemo<Record<string, LinkAnimationData>>(() => {
    const dataByLink: Record<string, LinkAnimationData> = {};
    for (const [linkId, pkts] of Object.entries(packets)) {
      const ids = parseLinkSvgIds(linkId, resolveNumericNodeId);
      const fromNode = ids ? nodeMap.get(ids[0]) : null;
      const toNode = ids ? nodeMap.get(ids[1]) : null;
      if (!fromNode || !toNode) continue;

      // Each directed link gets its own side of the shared physical link.
      let perpX = 0;
      let perpY = 0;
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

      dataByLink[linkId] = {
        dequeueEvents: [...pkts].sort((a, b) => a.dequeue_time - b.dequeue_time),
        enqueueEvents: [...pkts].sort((a, b) => a.enqueue_time - b.enqueue_time),
        fromNode,
        inFlightEndEvents: [...pkts].sort((a, b) => a.arrive_time - b.arrive_time),
        inFlightStartEvents: [...pkts].sort((a, b) => a.dequeue_time - b.dequeue_time),
        perpX,
        perpY,
        toNode,
      };
    }
    return dataByLink;
  }, [packets, nodeMap, resolveNumericNodeId]);

  const { packetDots, linkQueueDepths } = useMemo(() => {
    const shouldRebuild =
      animationCursorRef.current === null ||
      animTime < animationCursorRef.current.time ||
      animTime === 0;

    const existingAnimationState = animationCursorRef.current;
    const cursors = shouldRebuild
      ? Object.fromEntries(
          Object.keys(linkAnimationData).map((linkId) => [
            linkId,
            {
              activeInFlight: [],
              dequeueIdx: 0,
              depth: 0,
              enqueueIdx: 0,
              inFlightEndIdx: 0,
              inFlightStartIdx: 0,
            } satisfies LinkAnimationCursor,
          ])
        )
      : existingAnimationState!.cursors;

    const dots: Dot[] = [];
    const depths: Record<string, number> = {};

    for (const [linkId, data] of Object.entries(linkAnimationData)) {
      const cursor = cursors[linkId];

      while (
        cursor.enqueueIdx < data.enqueueEvents.length &&
        data.enqueueEvents[cursor.enqueueIdx].enqueue_time <= animTime
      ) {
        cursor.depth += data.enqueueEvents[cursor.enqueueIdx].size;
        cursor.enqueueIdx += 1;
      }

      while (
        cursor.dequeueIdx < data.dequeueEvents.length &&
        data.dequeueEvents[cursor.dequeueIdx].dequeue_time <= animTime
      ) {
        cursor.depth -= data.dequeueEvents[cursor.dequeueIdx].size;
        cursor.dequeueIdx += 1;
      }

      while (
        cursor.inFlightStartIdx < data.inFlightStartEvents.length &&
        data.inFlightStartEvents[cursor.inFlightStartIdx].dequeue_time <= animTime
      ) {
        cursor.activeInFlight.push(data.inFlightStartEvents[cursor.inFlightStartIdx]);
        cursor.inFlightStartIdx += 1;
      }

      while (
        cursor.inFlightEndIdx < data.inFlightEndEvents.length &&
        data.inFlightEndEvents[cursor.inFlightEndIdx].arrive_time <= animTime
      ) {
        const packetId = data.inFlightEndEvents[cursor.inFlightEndIdx].id;
        const removeIdx = cursor.activeInFlight.findIndex((packet) => packet.id === packetId);
        if (removeIdx !== -1) {
          cursor.activeInFlight.splice(removeIdx, 1);
        }
        cursor.inFlightEndIdx += 1;
      }

      depths[linkId] = Math.max(0, cursor.depth);

      const packetDotStride = Math.max(1, Math.ceil(cursor.activeInFlight.length / MAX_PACKET_DOTS_PER_LINK));
      for (let i = 0; i < cursor.activeInFlight.length; i += packetDotStride) {
        const packet = cursor.activeInFlight[i];
        const dur = packet.arrive_time - packet.dequeue_time;
        const progress = dur > 0 ? Math.min((animTime - packet.dequeue_time) / dur, 1) : 1;
        dots.push({
          key: `${linkId}-${packet.id}`,
          x: data.fromNode.x + (data.toNode.x - data.fromNode.x) * progress + data.perpX,
          y: data.fromNode.y + (data.toNode.y - data.fromNode.y) * progress + data.perpY,
        });
      }
    }

    animationCursorRef.current = { cursors, time: animTime };
    return { packetDots: dots, linkQueueDepths: depths };
  }, [animTime, linkAnimationData]);

  const hasPackets = Object.keys(packets).length > 0;
  const queueSeriesByLink = useMemo<Record<string, QueueSeries>>(() => {
    const maxTime = simEndTime > 0 ? simEndTime : 1;
    return Object.fromEntries(
      Object.entries(packets).map(([linkId, pkts]) => [linkId, buildQueueSeries(pkts, maxTime)])
    );
  }, [packets, simEndTime]);

  const selectedInfos = useMemo<QueueSelectionInfo[]>(() => {
    return selectedQueueCsvIds.map((csvId) => {
      const queueSeries = queueSeriesByLink[csvId] ?? buildQueueSeries([], simEndTime > 0 ? simEndTime : 1);
      const parts = csvId.split("-");
      const fromLabel = nodeMap.get(resolveNumericNodeId(parseInt(parts[0])))?.label ?? parts[0];
      const toLabel = nodeMap.get(resolveNumericNodeId(parseInt(parts[1])))?.label ?? parts[1];
      const startTime = selectedQueueStartTimes[csvId] ?? 0;
      const currentSnapshot = findLastSnapshotAtOrBeforeTime(queueSeries.snapshots, animTime);
      const currentBytes = currentSnapshot.bytes;
      const currentPackets = currentSnapshot.packets;
      const currentDelay = averageDelayAtTime(animTime, currentSnapshot.packets, currentSnapshot.enqueueTimeSum);
      const capacityPackets = Math.max(1, Math.floor(queueCapacityBytes / DATA_PACKET_BYTES));
      const ratio = queueCapacityBytes > 0 ? currentBytes / queueCapacityBytes : 0;
      const points = sampleQueuePoints(queueSeries.points, startTime, animTime);
      const maxSize = Math.max(1, queueCapacityBytes);
      const maxDelay = Math.max(1e-6, ...points.map((p) => p.delay));
      return {
        csvId,
        label: `${fromLabel} → ${toLabel}`,
        startTime,
        currentBytes,
        capacityBytes: queueCapacityBytes,
        currentDelay,
        currentPackets,
        capacityPackets,
        ratio,
        redMinBytes: appliedConfig.queue.queueAlgo === "RedQueueDisc"
          ? (queueCapacityBytes * appliedConfig.queue.redMinThresholdPct) / 100
          : null,
        redMaxBytes: appliedConfig.queue.queueAlgo === "RedQueueDisc"
          ? (queueCapacityBytes * appliedConfig.queue.redMaxThresholdPct) / 100
          : null,
        maxDelay,
        maxSize,
        points,
      };
    });
  }, [selectedQueueCsvIds, selectedQueueStartTimes, queueSeriesByLink, animTime, queueCapacityBytes, nodeMap, resolveNumericNodeId, simEndTime, appliedConfig.queue.queueAlgo, appliedConfig.queue.redMinThresholdPct, appliedConfig.queue.redMaxThresholdPct]);

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
      const marker = queueMarkerPosition(fromNode, toNode);
      overlays.push({
        csvId,
        fromX: fromNode.x,
        fromY: fromNode.y,
        toX: toNode.x,
        toY: toNode.y,
        markerX: marker.x,
        markerY: marker.y,
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
      const sim = simStart + ((performance.now() - wallStart) / 1000) * playbackRate;
      if (sim >= simEndTime) { setAnimTime(simEndTime); setAnimating(false); return; }
      setAnimTime(sim);
      animRaf.current = requestAnimationFrame(frame);
    }
    animRaf.current = requestAnimationFrame(frame);
    return () => { if (animRaf.current !== null) { cancelAnimationFrame(animRaf.current); animRaf.current = null; } };
  }, [animating, playbackRate, simEndTime]);

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
    const fetched: Record<string, PacketRow[]> = {};
    await Promise.all(
      data.linkIds.map(async (linkId) => {
        const r = await fetch(`/results/${data.runTag}/link/${linkId}`);
        if (r.ok) {
          const csvText = await r.text();
          fetched[linkId] = parsePacketCsv(csvText);
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
    setPackets({});
    setAnimating(false);
    setAnimTime(0);
    setSelectedNodeId(null);
    setSelectedQueueCsvIds([]);
    setSelectedQueueStartTimes({});
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
            load: defaultConfig.traffic.loadPct,
            workload: defaultConfig.traffic.workload,
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
            load: topologyConfig.traffic.loadPct,
            workload: topologyConfig.traffic.workload,
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
            load: topologyConfig.traffic.loadPct,
            workload: topologyConfig.traffic.workload,
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
          load: topologyConfig.traffic.loadPct,
          workload: topologyConfig.traffic.workload,
        };
      })();

      const res = await fetch("/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(runPayload),
      });
      if (!res.ok) throw new Error(`Backend Error: ${res.status}`);
      const initialStatus: RunStatus = await res.json();

      void maybeRequestNotificationPermission();

      let latestStatus = initialStatus;
      while (latestStatus.status === "queued" || latestStatus.status === "running") {
        await sleep(1500);
        const statusRes = await fetch(`/runs/${latestStatus.runTag}/status`, { cache: "no-store" });
        if (!statusRes.ok) throw new Error(`Backend Error: ${statusRes.status}`);
        latestStatus = await statusRes.json();
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
        <Image src="/sun.png" alt="" width={20} height={20} className={theme === "dark" ? "invert" : ""} />
      </button>

      <main className="min-h-screen bg-stone-100 text-stone-900 dark:bg-stone-950 dark:text-stone-50">
        <div className="mx-auto max-w-7xl px-6 py-10 md:px-10">
          <header className="mb-8 flex flex-col gap-6 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <p className="text-sm uppercase tracking-[0.3em] text-stone-500 dark:text-stone-400">ns-3 simulation</p>
              <h1 className="mt-3 text-3xl font-semibold">Network Traffic Visualization</h1>
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
                <span className="rounded-full bg-stone-100 px-3 py-1 dark:bg-stone-800">
                  Load: {appliedConfig.traffic.loadPct}%
                </span>
                <span className="rounded-full bg-stone-100 px-3 py-1 dark:bg-stone-800">
                  {appliedConfig.traffic.workload}
                </span>
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
              <select
                value={playbackRate}
                onChange={(e) => setPlaybackRate(Number(e.target.value))}
                disabled={!hasPackets}
                className="h-8 rounded-md border border-stone-200 bg-white px-2 text-xs text-stone-700 disabled:opacity-50 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-200"
                aria-label="Playback speed"
              >
                {playbackRates.map((rate) => (
                  <option key={rate} value={rate}>
                    {rate}x
                  </option>
                ))}
              </select>
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
                  const strokeWidth = hasPackets && depth > 0 ? Math.min(3.5, 1 + ratio * 2.5) : 1;

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
                    <g key={`overlay-${q.csvId}`}>
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
                        fill="rgb(220, 229, 124)"
                        stroke={isFocused ? "rgb(220, 229, 124)" : "none"}
                        strokeWidth={isFocused ? 2 : 0}
                        style={{ cursor: "pointer" }}
                        onClick={(e) => {
                          e.stopPropagation();
                          setFocusedQueueCsvId(q.csvId);
                        }}
                      />
                    </g>
                  );
                })}

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
                          fill={nodeFill(theme)} stroke={nodeStroke(node.type)} strokeWidth="2" />
                      ) : (
                        <circle cx={node.x} cy={node.y} r="12"
                          fill={nodeFill(theme)} stroke={nodeStroke(node.type)} strokeWidth="2" />
                      )}
                      <text x={node.x} y={node.y + 31} textAnchor="middle"
                        className="fill-stone-500 text-[10px] dark:fill-stone-400">
                        {node.label}
                      </text>
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
                    const marker = queueMarkerPosition(fromNode, toNode);
                    const isSelected = selectedQueueCsvIds.includes(csvId);
                    if (isSelected) return null;
                    return (
                      <rect key={csvId}
                        x={marker.x - 7} y={marker.y - 5} width={14} height={10} rx={2}
                        fill="white"
                        stroke="none"
                        strokeWidth={0}
                        style={{ cursor: "pointer" }}
                        onClick={(e) => {
                          e.stopPropagation();
                          setSelectedQueueCsvIds((prev) => {
                            if (prev.includes(csvId)) {
                              if (focusedQueueCsvId === csvId) setFocusedQueueCsvId(null);
                              setSelectedQueueStartTimes((times) => {
                                const next = { ...times };
                                delete next[csvId];
                                return next;
                              });
                              return prev.filter((id) => id !== csvId);
                            }
                            setSelectedQueueStartTimes((times) => (
                              csvId in times ? times : { ...times, [csvId]: animTime }
                            ));
                            const next = [...prev, csvId];
                            setFocusedQueueCsvId(csvId);
                            if (next.length <= MAX_SELECTED_QUEUES) return next;
                            const trimmed = next.slice(next.length - MAX_SELECTED_QUEUES);
                            const removedIds = next.filter((id) => !trimmed.includes(id));
                            setSelectedQueueStartTimes((times) => {
                              const nextTimes = { ...times };
                              for (const removedId of removedIds) {
                                delete nextTimes[removedId];
                              }
                              return nextTimes;
                            });
                            return trimmed;
                          });
                        }}
                      />
                    );
                  });
                })()}
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
                    const delayAxis = delayUnitScale(info.maxDelay);
                    const redMinY = info.redMinBytes === null
                      ? null
                      : pad + innerH - (Math.min(info.redMinBytes, info.maxSize) / info.maxSize) * innerH;
                    const redMaxY = info.redMaxBytes === null
                      ? null
                      : pad + innerH - (Math.min(info.redMaxBytes, info.maxSize) / info.maxSize) * innerH;
                    const sizePath = info.points
                      .map((p, idx) => {
                        const x = pad + (p.time / maxTime) * innerW;
                        const y = pad + innerH - (p.size / info.maxSize) * innerH;
                        return `${idx === 0 ? "M" : "L"}${x.toFixed(2)} ${y.toFixed(2)}`;
                      })
                      .join(" ");
                    const delayPath = info.points
                      .map((p, idx) => {
                        const x = pad + (p.time / maxTime) * innerW;
                        const y = pad + innerH - (p.delay / info.maxDelay) * innerH;
                        return `${idx === 0 ? "M" : "L"}${x.toFixed(2)} ${y.toFixed(2)}`;
                      })
                      .join(" ");
                    const currentTime = Math.min(animTime, maxTime);
                    const currentX = pad + (currentTime / maxTime) * innerW;

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
                        <div className="mt-1 text-xs text-stone-400" style={{ fontVariantNumeric: "tabular-nums" }}>
                          delay: {formatDelay(info.currentDelay)}
                        </div>
                        <svg width={width} height={height} className="mt-3 block rounded border border-stone-200 bg-white dark:border-stone-700 dark:bg-stone-950">
                          <line x1={pad} y1={height - pad} x2={width - pad} y2={height - pad} stroke="rgb(148, 163, 184)" strokeWidth={1} />
                          <line x1={pad} y1={pad} x2={pad} y2={height - pad} stroke="rgb(148, 163, 184)" strokeWidth={1} />
                          {redMinY !== null && (
                            <line x1={pad} y1={redMinY} x2={width - pad} y2={redMinY} stroke="rgb(239, 68, 68)" strokeWidth={1} strokeDasharray="4 3" />
                          )}
                          {redMaxY !== null && (
                            <line x1={pad} y1={redMaxY} x2={width - pad} y2={redMaxY} stroke="rgb(185, 28, 28)" strokeWidth={1} strokeDasharray="4 3" />
                          )}
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
                          <span>orange: avg wait delay ({delayAxis.unit})</span>
                          {info.redMinBytes !== null && <span>red: RED min/max</span>}
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
        <footer className="pb-8 text-center text-xs text-stone-500 dark:text-stone-400">
          <p>© 2026 Sam Lee</p>
          <p className="mt-1">
            <a
              href="https://www.epfl.ch/labs/nal/"
              target="_blank"
              rel="noreferrer"
              className="transition hover:opacity-70"
            >
              Network Architecture Lab
            </a>
              , EPFL ·{" "}
            <a
              href="https://github.com/jamsamjam/ns3-dcn"
              target="_blank"
              rel="noreferrer"
              className="transition hover:opacity-70"
            >
              GitHub
            </a>
          </p>
        </footer>
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

            <TopologyWizard initialConfig={appliedConfig} onSubmit={applyWizardConfig} />
          </div>
        </div>
      )}
    </>
  );
}
