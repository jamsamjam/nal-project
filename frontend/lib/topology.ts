export type Node = {
  id: string;
  label: string;
  type: "core" | "agg" | "tor" | "host";
  x: number;
  y: number;
};

export type Link = { from: string; to: string };

export function buildFatTree(k: number, startX: number) {
  const nodes: Node[] = [];
  const links: Link[] = [];

  if (!Number.isInteger(k) || k < 2 || k % 2 !== 0) {
    return { nodes, links, error: "k must be an even integer >= 2" };
  }

  const half = k / 2;
  const podWidth = 220;
  const coreY = 60;
  const aggY = 180;
  const torY = 300;
  const hostY = 420;

  const coreCount = half * half;
  const podSpan = (k - 1) * podWidth + (half - 1) * 70;
  const coreSpan = (coreCount - 1) * 90;
  const coreStartX = startX + (podSpan - coreSpan) / 2;

  for (let i = 0; i < coreCount; i++) {
    nodes.push({
      id: `core-${i}`,
      label: `C${i}`,
      type: "core",
      x: coreStartX + i * 90,
      y: coreY,
    });
  }

  for (let p = 0; p < k; p++) {
    const podX = startX + p * podWidth;

    for (let a = 0; a < half; a++) {
      const aggId = `pod-${p}-agg-${a}`;
      nodes.push({
        id: aggId,
        label: `P${p} A${a}`,
        type: "agg",
        x: podX + a * 70,
        y: aggY,
      });

      for (let c = 0; c < half; c++) {
        links.push({ from: aggId, to: `core-${a * half + c}` });
      }
    }

    for (let e = 0; e < half; e++) {
      const torId = `pod-${p}-tor-${e}`;
      nodes.push({
        id: torId,
        label: `P${p} T${e}`,
        type: "tor",
        x: podX + e * 70,
        y: torY,
      });

      for (let a = 0; a < half; a++) {
        links.push({ from: torId, to: `pod-${p}-agg-${a}` });
      }

      for (let h = 0; h < half; h++) {
        const hostId = `pod-${p}-host-${e}-${h}`;
        nodes.push({
          id: hostId,
          label: `H${p}.${e}.${h}`,
          type: "host",
          x: podX + e * 70 - 18 + h * 36,
          y: hostY,
        });
        links.push({ from: hostId, to: torId });
      }
    }
  }

  return { nodes, links, error: null as string | null };
}

export function nodeStroke(type: Node["type"]) {
  if (type === "core") return "rgb(186, 186, 186)";
  if (type === "agg") return "rgb(62, 117, 255)";
  if (type === "tor") return "rgb(138, 197, 255)";
  return "rgb(138, 197, 255)";
}
