from __future__ import annotations

import argparse
from pathlib import Path

import matplotlib.pyplot as plt
import matplotlib.ticker as ticker


_PALETTE = [
    "tomato",
    "steelblue",
    "mediumseagreen",
    "goldenrod",
    "mediumpurple",
    "darkorange",
    "cadetblue",
]


def parse_workload_file(path: Path) -> tuple[float, list[float], list[float]]:
    lines = [line.strip() for line in path.read_text().splitlines() if line.strip()]
    if len(lines) < 2:
        raise ValueError(f"{path} does not contain enough data.")

    avg = float(lines[0])
    x_values: list[float] = []
    cdf_values: list[float] = []

    for line_no, line in enumerate(lines[1:], start=2):
        parts = line.split()
        if len(parts) < 2:
            raise ValueError(f"{path}:{line_no} is not in 'x cdf' format: {line!r}")

        x_values.append(float(parts[0]))
        cdf_values.append(float(parts[1]))

    return avg, x_values, cdf_values


def build_parser() -> argparse.ArgumentParser:
    script_dir = Path(__file__).resolve().parent
    default_input_dir = script_dir.parent / "workloads"
    default_output = script_dir / "workload_cdfs.png"

    parser = argparse.ArgumentParser(
        description="Plot all workload CDF files on a single graph."
    )
    parser.add_argument(
        "--input-dir",
        type=Path,
        default=default_input_dir,
        help=f"Directory containing workload files (default: {default_input_dir})",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=default_output,
        help=f"Output image path (default: {default_output})",
    )
    parser.add_argument(
        "--title",
        default="Message Size Distribution CDF",
        help="Plot title",
    )
    parser.add_argument(
        "--xscale",
        choices=("linear", "log"),
        default="log",  # log is almost always correct for network traffic
        help="Scale for the x-axis (default: log)",
    )
    return parser


def _apply_style() -> None:
    """Apply clean, publication-ready matplotlib style."""
    plt.rcParams.update({
        "figure.facecolor": "white",
        "axes.facecolor": "white",
        "axes.edgecolor": "#CCCCCC",
        "axes.linewidth": 0.8,
        "axes.grid": True,
        "grid.color": "#E8E8E8",
        "grid.linewidth": 0.7,
        "grid.linestyle": "-",
        "axes.axisbelow": True,
        "xtick.color": "#444444",
        "ytick.color": "#444444",
        "xtick.labelsize": 10,
        "ytick.labelsize": 10,
        "axes.labelsize": 12,
        "axes.labelweight": "bold",
        "axes.labelcolor": "#222222",
        "axes.titlesize": 14,
        "axes.titleweight": "bold",
        "axes.titlepad": 12,
        "legend.frameon": True,
        "legend.framealpha": 0.92,
        "legend.edgecolor": "#CCCCCC",
        "legend.fontsize": 9.5,
        "legend.title_fontsize": 10,
        "lines.linewidth": 2.0,
        "font.family": "sans-serif",
    })


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()

    input_dir = args.input_dir.resolve()
    output_path = args.output.resolve()

    if not input_dir.exists():
        raise FileNotFoundError(f"Input directory not found: {input_dir}")

    workload_files = sorted(path for path in input_dir.iterdir() if path.is_file())
    if not workload_files:
        raise FileNotFoundError(f"No workload files found in: {input_dir}")

    _apply_style()

    n = len(workload_files)
    palette = (_PALETTE * ((n // len(_PALETTE)) + 1))[:n]
    line_styles = ["-", "--", "-.", ":"]

    fig, ax = plt.subplots(figsize=(11, 7))

    for index, (color, workload_file) in enumerate(zip(palette, workload_files)):
        avg, x_values, cdf_values = parse_workload_file(workload_file)
        label = f"{workload_file.stem} (avg: {avg:.1f})"

        ax.plot(
            x_values,
            cdf_values,
            label=label,
            linewidth=2.2,
            color=color,
            linestyle=line_styles[index % len(line_styles)],
            alpha=0.9,
        )

    ax.set_title(args.title)
    ax.set_xlabel("Message Size (bytes)")
    ax.set_ylabel("CDF")
    ax.set_ylim(-0.02, 1.05)
    ax.set_xscale(args.xscale)

    if args.xscale == "log":
        ax.xaxis.set_major_formatter(ticker.LogFormatterSciNotation(labelOnlyBase=False))

    # Subtle top/right spine removal for cleaner look
    ax.spines["top"].set_visible(False)
    ax.spines["right"].set_visible(False)

    legend = ax.legend(
        loc="lower right",
        title="Workload",
        frameon=True,
        shadow=True,
    )
    legend.get_frame().set_linewidth(0.8)

    fig.tight_layout()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(output_path, dpi=200, bbox_inches="tight")
    print(f"Saved plot to: {output_path}")


if __name__ == "__main__":
    main()