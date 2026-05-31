"use client";

import { useMemo, useState } from "react";

export type LayerType = 1 | 2 | 3;

export type TopologyConfig = {
  layers: LayerType;
  topology:
    | { type: "single_tor"; torCount: 1; serversPerTor: number }
    | { type: "two_layer"; torCount: number; aggCount: number; serversPerTor: number }
    | { type: "three_layer"; k: number };
  link: {
    rate: string;
    delay: string;
  };
  queue: {
    congestionAlgo: string;
    queueAlgo: string;
  };
};

type Props = {
  onSubmit?: (config: TopologyConfig) => void;
  onChange?: (config: Partial<TopologyConfig>) => void;
};

type Step = "layers" | "shape" | "servers" | "link" | "queue";

const congestionAlgos = ["TcpNewReno", "TcpCubic", "TcpDctcp"];
const queueAlgos = ["FifoQueueDisc", "RedQueueDisc"];

export default function TopologyWizard({ onSubmit, onChange }: Props) {
  const [layers, setLayers] = useState<LayerType>(1);

  const [torCount, setTorCount] = useState(2);
  const [aggCount, setAggCount] = useState(2);
  const [k, setK] = useState(4);

  const [serversPerTor, setServersPerTor] = useState(8);
  const [linkRate, setLinkRate] = useState("10Gbps");
  const [linkDelay, setLinkDelay] = useState("1ms");

  const [congestionAlgo, setCongestionAlgo] = useState(congestionAlgos[0]);
  const [queueAlgo, setQueueAlgo] = useState(queueAlgos[0]);

  const [stepIndex, setStepIndex] = useState(0);

  const steps = useMemo<Step[]>(() => {
    if (layers === 1) return ["layers", "servers", "link", "queue"];
    if (layers === 2) return ["layers", "shape", "servers", "link", "queue"];
    return ["layers", "shape", "link", "queue"];
  }, [layers]);

  const step = steps[stepIndex];

  const config = useMemo<TopologyConfig>(() => {
    const topology =
      layers === 1
        ? { type: "single_tor" as const, torCount: 1 as const, serversPerTor }
        : layers === 2
          ? { type: "two_layer" as const, torCount, aggCount, serversPerTor }
          : { type: "three_layer" as const, k };

    return {
      layers,
      topology,
      link: { rate: linkRate, delay: linkDelay },
      queue: { congestionAlgo, queueAlgo },
    };
  }, [layers, torCount, aggCount, k, serversPerTor, linkRate, linkDelay, congestionAlgo, queueAlgo]);

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
            <p className="text-sm font-semibold">linkrate, delay</p>
            <TextField label="Link Rate" value={linkRate} onChange={setLinkRate} placeholder="10Gbps" />
            <TextField label="Link Delay" value={linkDelay} onChange={setLinkDelay} placeholder="1ms" />
          </div>
        )}

        {step === "queue" && (
          <div className="space-y-3">
            <p className="text-sm font-semibold">congestion / queue algo</p>
            <SelectField label="Congestion Algo" value={congestionAlgo} options={congestionAlgos} onChange={setCongestionAlgo} />
            <SelectField label="Queue Algo" value={queueAlgo} options={queueAlgos} onChange={setQueueAlgo} />
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
      return "Link";
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
