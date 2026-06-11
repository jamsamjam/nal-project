"use client";

import { useMemo, useState } from "react";

export type LayerType = 1 | 2 | 3;

export type TopologyShape =
  | { type: "single_tor"; torCount: 1; serversPerTor: number }
  | { type: "two_layer"; torCount: number; aggCount: number; serversPerTor: number }
  | { type: "three_layer"; k: number };

export type LinkConfig = {
  serverToTorRate: string;
  torOversubRatio: number;
  aggOversubRatio: number;
  torToAggRate: string;
  aggToCoreRate: string;
  delay: string;
};

export type TopologyConfig = {
  layers: LayerType;
  topology: TopologyShape;
  link: LinkConfig;
  queue: {
    congestionAlgo: string;
    queueAlgo: string;
    redMinThresholdPct: number;
    redMaxThresholdPct: number;
  };
};

type Props = {
  onSubmit?: (config: TopologyConfig) => void;
  onChange?: (config: Partial<TopologyConfig>) => void;
};

type Step = "layers" | "shape" | "servers" | "link" | "queue";

const congestionAlgos = ["TcpNewReno", "TcpCubic", "TcpDctcp"];
const queueAlgos = ["FifoQueueDisc", "RedQueueDisc"];

export function parseLinkRateBps(linkRate: string): number {
  const r = linkRate.trim();
  if (r.endsWith("Gbps")) return parseFloat(r) * 1e9;
  if (r.endsWith("Mbps")) return parseFloat(r) * 1e6;
  if (r.endsWith("Kbps")) return parseFloat(r) * 1e3;
  return parseFloat(r);
}

function formatRateBps(bps: number): string {
  const units = [
    { suffix: "Gbps", value: 1e9 },
    { suffix: "Mbps", value: 1e6 },
    { suffix: "Kbps", value: 1e3 },
  ];

  for (const unit of units) {
    if (bps >= unit.value) {
      return `${trimDecimal(bps / unit.value)}${unit.suffix}`;
    }
  }

  return `${trimDecimal(bps)}bps`;
}

function trimDecimal(value: number): string {
  if (!Number.isFinite(value)) return "0";
  return value.toFixed(3).replace(/\.?0+$/, "");
}

function safeRatio(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  return value;
}

export function deriveLinkConfig(layers: LayerType, topology: TopologyShape, serverToTorRate: string, torOversubRatio: number, delay: string): LinkConfig {
  const serverToTorBps = parseLinkRateBps(serverToTorRate);
  const safeServerToTorRate = Number.isFinite(serverToTorBps) && serverToTorBps > 0 ? serverToTorRate : "10Gbps";
  const normalizedServerToTorBps = parseLinkRateBps(safeServerToTorRate);
  const normalizedTorOversubRatio = safeRatio(torOversubRatio);
  const aggOversubRatio = 1;

  let torDownlinks = 1;
  let torUplinks = 1;
  let aggDownlinks = 1;
  let aggUplinks = 1;

  if (topology.type === "two_layer") {
    torDownlinks = Math.max(1, topology.serversPerTor);
    torUplinks = Math.max(1, topology.aggCount);
  } else if (topology.type === "three_layer") {
    const half = Math.max(1, topology.k / 2);
    torDownlinks = half;
    torUplinks = half;
    aggDownlinks = half;
    aggUplinks = half;
  }

  const torToAggBps =
    layers === 1
      ? normalizedServerToTorBps
      : (normalizedServerToTorBps * torDownlinks) / (torUplinks * normalizedTorOversubRatio);

  const aggToCoreBps =
    layers < 3
      ? torToAggBps
      : (torToAggBps * aggDownlinks) / (aggUplinks * aggOversubRatio);

  return {
    serverToTorRate: safeServerToTorRate,
    torOversubRatio: normalizedTorOversubRatio,
    aggOversubRatio,
    torToAggRate: formatRateBps(Math.max(1, torToAggBps)),
    aggToCoreRate: formatRateBps(Math.max(1, aggToCoreBps)),
    delay,
  };
}

export function getBottleneckLinkRate(config: TopologyConfig): string {
  const candidates = [config.link.serverToTorRate];
  if (config.layers >= 2) candidates.push(config.link.torToAggRate);
  if (config.layers >= 3) candidates.push(config.link.aggToCoreRate);

  const minBps = Math.min(...candidates.map((rate) => parseLinkRateBps(rate)));
  return formatRateBps(minBps);
}

export default function TopologyWizard({ onSubmit, onChange }: Props) {
  const [layers, setLayers] = useState<LayerType>(1);

  const [torCount, setTorCount] = useState(2);
  const [aggCount, setAggCount] = useState(2);
  const [k, setK] = useState(4);

  const [serversPerTor, setServersPerTor] = useState(8);
  const [serverToTorRate, setServerToTorRate] = useState("10Gbps");
  const [torOversubRatio, setTorOversubRatio] = useState(1);
  const [linkDelay, setLinkDelay] = useState("1ms");

  const [congestionAlgo, setCongestionAlgo] = useState(congestionAlgos[0]);
  const [queueAlgo, setQueueAlgo] = useState(queueAlgos[0]);
  const [redMinThresholdPct, setRedMinThresholdPct] = useState(20);
  const [redMaxThresholdPct, setRedMaxThresholdPct] = useState(60);

  const [stepIndex, setStepIndex] = useState(0);

  const steps = useMemo<Step[]>(() => {
    if (layers === 1) return ["layers", "servers", "link", "queue"];
    if (layers === 2) return ["layers", "shape", "servers", "link", "queue"];
    return ["layers", "shape", "link", "queue"];
  }, [layers]);

  const step = steps[stepIndex];

  const topology = useMemo<TopologyShape>(() => {
    if (layers === 1) return { type: "single_tor", torCount: 1, serversPerTor };
    if (layers === 2) return { type: "two_layer", torCount, aggCount, serversPerTor };
    return { type: "three_layer", k };
  }, [layers, torCount, aggCount, serversPerTor, k]);

  const link = useMemo(
    () => deriveLinkConfig(layers, topology, serverToTorRate, torOversubRatio, linkDelay),
    [layers, topology, serverToTorRate, torOversubRatio, linkDelay]
  );

  const config = useMemo<TopologyConfig>(() => {
    const usesDctcpThreshold = queueAlgo === "RedQueueDisc" && congestionAlgo === "TcpDctcp";
    const effectiveRedMaxThresholdPct = usesDctcpThreshold ? redMinThresholdPct : redMaxThresholdPct;

    return {
      layers,
      topology,
      link,
      queue: {
        congestionAlgo,
        queueAlgo,
        redMinThresholdPct,
        redMaxThresholdPct: effectiveRedMaxThresholdPct,
      },
    };
  }, [layers, topology, link, congestionAlgo, queueAlgo, redMinThresholdPct, redMaxThresholdPct]);

  function goNext() {
    setStepIndex((prev) => Math.min(prev + 1, steps.length - 1));
    onChange?.(config);
  }

  function goBack() {
    setStepIndex((prev) => Math.max(prev - 1, 0));
  }

  function finish() {
    onSubmit?.(config);
  }

  return (
    <div className="rounded-xl border border-stone-300 bg-white p-5 text-stone-900 shadow-sm">
      <div className="mb-4">
        <p className="text-xs font-semibold uppercase tracking-wide text-stone-500">Topology Wizard</p>
        <h2 className="text-xl font-bold">Network Topology Configuration</h2>
      </div>

      <div className="mb-4 flex gap-2 text-xs">
        {steps.map((s, i) => (
          <span
            key={s + i}
            className={`rounded-full px-3 py-1 ${i === stepIndex ? "bg-stone-900 text-white" : "bg-stone-100 text-stone-600"}`}
          >
            {labelForStep(s)}
          </span>
        ))}
      </div>

      <div className="rounded-lg border border-stone-200 p-4">
        {step === "layers" && (
          <div className="space-y-3">
            <p className="text-sm font-semibold"># Layers?</p>
            <div className="grid gap-2 sm:grid-cols-3">
              {[1, 2, 3].map((v) => (
                <button
                  key={v}
                  type="button"
                  className={`rounded-md border px-3 py-2 text-left ${layers === v ? "border-stone-900 bg-stone-900 text-white" : "border-stone-300"}`}
                  onClick={() => {
                    setLayers(v as LayerType);
                    setStepIndex(0);
                  }}
                >
                  <p className="font-semibold">{v} Layer</p>
                  <p className={`text-xs ${layers === v ? "text-stone-200" : "text-stone-500"}`}>{descriptionForLayer(v as LayerType)}</p>
                </button>
              ))}
            </div>
          </div>
        )}

        {step === "shape" && layers === 2 && (
          <div className="space-y-3">
            <p className="text-sm font-semibold"># ToRs, # Agg</p>
            <NumberField label="# ToRs" value={torCount} onChange={setTorCount} min={1} />
            <NumberField label="# Agg" value={aggCount} onChange={setAggCount} min={1} />
          </div>
        )}

        {step === "shape" && layers === 3 && (
          <div className="space-y-3">
            <p className="text-sm font-semibold">ToR + Aggregation + Core</p>
            <NumberField label="# Pods" value={k} onChange={setK} min={2} step={2} />
          </div>
        )}

        {step === "servers" && (layers === 1 || layers === 2) && (
          <div className="space-y-3">
            <p className="text-sm font-semibold"># Servers per ToR</p>
            <NumberField label="Servers per ToR" value={serversPerTor} onChange={setServersPerTor} min={1} />
          </div>
        )}

        {step === "link" && (
          <div className="space-y-3">
            <p className="text-sm font-semibold">Link Rates / Oversubscription</p>
            <TextField label="Server-ToR Rate" value={serverToTorRate} onChange={setServerToTorRate} placeholder="10Gbps" />
            {layers >= 2 && (
              <NumberField
                label="ToR Oversub Ratio"
                value={torOversubRatio}
                onChange={setTorOversubRatio}
                min={0.1}
                step={0.1}
              />
            )}
            {layers === 3 && (
              <p className="rounded-md bg-stone-100 px-3 py-2 text-xs text-stone-600">Agg oversubscription is fixed to 1:1.</p>
            )}
            <TextField label="Link Delay" value={linkDelay} onChange={setLinkDelay} placeholder="1ms" />
            <CalculatedField label="Calculated ToR-Agg Rate" value={link.torToAggRate} />
            {layers === 3 && <CalculatedField label="Calculated Agg-Core Rate" value={link.aggToCoreRate} />}
          </div>
        )}

        {step === "queue" && (
          <div className="space-y-3">
            <p className="text-sm font-semibold">congestion / queue algo</p>
            <SelectField label="Congestion Algo" value={congestionAlgo} options={congestionAlgos} onChange={setCongestionAlgo} />
            <SelectField label="Queue Algo" value={queueAlgo} options={queueAlgos} onChange={setQueueAlgo} />
            {queueAlgo === "RedQueueDisc" && (
              <>
                {congestionAlgo === "TcpDctcp" ? (
                  <>
                    <NumberField
                      label="RED Threshold"
                      value={redMinThresholdPct}
                      onChange={(value) => {
                        const next = clampPercent(value);
                        setRedMinThresholdPct(next);
                        setRedMaxThresholdPct(next);
                      }}
                      min={0}
                      step={1}
                    />
                    <p className="rounded-md bg-stone-100 px-3 py-2 text-xs text-stone-600">
                      DCTCP uses a single RED threshold.
                    </p>
                  </>
                ) : (
                  <>
                    <NumberField
                      label="RED Min Threshold"
                      value={redMinThresholdPct}
                      onChange={(value) => setRedMinThresholdPct(clampPercent(value))}
                      min={0}
                      step={1}
                    />
                    <NumberField
                      label="RED Max Threshold"
                      value={redMaxThresholdPct}
                      onChange={(value) => setRedMaxThresholdPct(clampPercent(value))}
                      min={0}
                      step={1}
                    />
                    <p className="rounded-md bg-stone-100 px-3 py-2 text-xs text-stone-600">
                      Thresholds are entered as percentages of the computed queue capacity.
                    </p>
                  </>
                )}
              </>
            )}
          </div>
        )}
      </div>

      <div className="mt-4 flex items-center justify-between">
        <button
          type="button"
          onClick={goBack}
          disabled={stepIndex === 0}
          className="rounded-md border border-stone-300 px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-40"
        >
          Back
        </button>

        {stepIndex < steps.length - 1 ? (
          <button type="button" onClick={goNext} className="rounded-md bg-stone-900 px-3 py-2 text-sm text-white">
            Next
          </button>
        ) : (
          <button type="button" onClick={finish} className="rounded-md bg-stone-900 px-3 py-2 text-sm text-white">
            Apply Configuration
          </button>
        )}
      </div>

      <pre className="mt-4 overflow-x-auto rounded-lg bg-stone-900 p-3 text-xs text-stone-100">
        {JSON.stringify(config, null, 2)}
      </pre>
    </div>
  );
}

function NumberField({
  label,
  value,
  onChange,
  min,
  step = 1,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min: number;
  step?: number;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-stone-600">{label}</span>
      <input
        type="number"
        className="w-full rounded-md border border-stone-300 px-3 py-2 text-sm"
        value={value}
        min={min}
        step={step}
        onChange={(e) => onChange(Math.max(min, Number(e.target.value) || min))}
      />
    </label>
  );
}

function TextField({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-stone-600">{label}</span>
      <input
        className="w-full rounded-md border border-stone-300 px-3 py-2 text-sm"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

function CalculatedField({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-dashed border-stone-300 bg-stone-50 px-3 py-2">
      <p className="mb-1 text-xs font-medium text-stone-600">{label}</p>
      <p className="text-sm font-semibold text-stone-900">{value}</p>
    </div>
  );
}

function SelectField({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: string[];
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-stone-600">{label}</span>
      <select
        className="w-full rounded-md border border-stone-300 px-3 py-2 text-sm"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </label>
  );
}

function labelForStep(step: Step): string {
  switch (step) {
    case "layers":
      return "Layers";
    case "shape":
      return "Shape";
    case "servers":
      return "Servers";
    case "link":
      return "Links";
    case "queue":
      return "Queue";
    default:
      return step;
  }
}

function descriptionForLayer(layer: LayerType): string {
  if (layer === 1) return "1 ToR";
  if (layer === 2) return "ToR + Aggregation";
  return "ToR + Aggregation + Core";
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}
