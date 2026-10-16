"""Reproduce analytical figures: python3 docs/scripts/render-research-figures.py.

Requires matplotlib and numpy. Outputs are committed; building docs needs no Python.
All curves are analytical illustrations, not observed accuracy or runtime results.
"""
from pathlib import Path
import json

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
PARAMS = json.loads((ROOT / "evaluations/illustrative-figures.json").read_text())
OUT = ROOT / "public/figures"
OUT.mkdir(parents=True, exist_ok=True)
plt.rcParams.update({
    "font.family": "DejaVu Sans", "font.size": 11,
    "axes.titlesize": 13, "axes.labelsize": 11,
    "axes.spines.top": False, "axes.spines.right": False,
    "svg.fonttype": "path", "svg.hashsalt": "cluevia-research-v1",
    "pdf.fonttype": 42,
})


def canvas(dark=False, width=7.2, height=4.5):
    palette = {
        "paper": "#23231f" if dark else "#fffdf8",
        "ink": "#eee8dc" if dark else "#28251f",
        "muted": "#b2ac9e" if dark else "#736e63",
        "grid": "#48473e" if dark else "#e0dbd0",
        "red": "#e4907b" if dark else "#a73c2e",
        "teal": "#8cc1b1" if dark else "#316b60",
        "blue": "#a1b9d8" if dark else "#4f7094",
    }
    fig, ax = plt.subplots(figsize=(width, height), layout="constrained")
    fig.set_facecolor(palette["paper"])
    ax.set_facecolor(palette["paper"])
    ax.tick_params(colors=palette["muted"])
    ax.xaxis.label.set_color(palette["ink"])
    ax.yaxis.label.set_color(palette["ink"])
    for spine in ax.spines.values():
        spine.set_color(palette["grid"])
    ax.grid(alpha=.7, color=palette["grid"], linewidth=.7)
    ax.set_axisbelow(True)
    return fig, ax, palette


def finish(fig, ax, p, name, dark):
    handles, labels = ax.get_legend_handles_labels()
    if handles:
        legend = ax.legend(frameon=False, fontsize=10)
        for t in legend.get_texts():
            t.set_color(p["ink"])
    suffix = ".dark" if dark else ""
    fig.savefig(OUT / f"{name}{suffix}.svg", metadata={"Date": None})
    if not dark:
        fig.savefig(OUT / f"{name}.pdf", metadata={"CreationDate": None, "ModDate": None})
        fig.savefig(OUT / f"{name}.png", dpi=220)
    plt.close(fig)


def render(dark):
    x = np.linspace(0, 1, 301)
    q = PARAMS["supportCurve"]["fixedSecondScore"]
    fig, ax, p = canvas(dark)
    ax.plot(x, x*q, color=p["red"], lw=2.4, label=r"AND: $p_1 p_2$")
    ax.plot(x, 1-(1-x)*(1-q), color=p["teal"], lw=2.4, ls="--", label=r"OR: $1-(1-p_1)(1-p_2)$")
    ax.plot(x, x, color=p["muted"], lw=1, ls=":", label=r"Reference: $p_1$")
    ax.set(xlabel=r"First input score $p_1$", ylabel="Aggregated support score", xlim=(0,1), ylim=(0,1.03))
    ax.set_title(r"Independent inputs · fixed $p_2=0.60$", color=p["ink"], loc="left", pad=16)
    finish(fig, ax, p, "support-curves", dark)

    fig, ax, p = canvas(dark)
    b, c = PARAMS["sharedEvidence"]["b"], PARAMS["sharedEvidence"]["c"]
    exact = x*(1-(1-b)*(1-c))
    naive = 1-(1-x*b)*(1-x*c)
    ax.fill_between(x, exact, naive, color=p["red"], alpha=.12)
    ax.plot(x, exact, color=p["teal"], lw=2.4, label="Shared atom retained")
    ax.plot(x, naive, color=p["red"], lw=2.2, ls="--", label="Branches incorrectly treated as independent")
    a = PARAMS["sharedEvidence"]["a"]
    for value, color, dy in [(a*(1-(1-b)*(1-c)),p["teal"],-27), (1-(1-a*b)*(1-a*c),p["red"],15)]:
        ax.scatter([a], [value], color=color, zorder=4, s=32)
        ax.annotate(f"{value:.4f}", (a,value), xytext=(8,dy), textcoords="offset points", color=color, fontsize=11)
    ax.set(xlabel=r"Shared input score $a$", ylabel="Root support score", xlim=(0,1), ylim=(0,1.06))
    ax.set_title(r"$(a \wedge b) \vee (a \wedge c)$ · $b=0.70$, $c=0.60$", color=p["ink"], loc="left", pad=16)
    finish(fig, ax, p, "shared-evidence", dark)

    fig, ax, p = canvas(dark)
    lower = np.maximum(0, x+q-1)
    upper = np.minimum(x,q)
    ax.fill_between(x, lower, upper, color=p["blue"], alpha=.20, label="All admissible AND probabilities")
    ax.plot(x, lower, color=p["blue"], lw=1.4)
    ax.plot(x, upper, color=p["blue"], lw=1.4)
    ax.plot(x, x*q, color=p["red"], lw=2.3, ls="--", label="Independent joint model")
    ax.set(xlabel=r"Marginal probability $p_1$", ylabel=r"$P(A \cap B)$", xlim=(0,1), ylim=(0,1.03))
    ax.set_title(r"Unknown dependence · fixed $p_2=0.60$", color=p["ink"], loc="left", pad=16)
    finish(fig, ax, p, "dependence-bounds", dark)

    fig, ax, p = canvas(dark)
    lr = np.logspace(-1, 1, 301)
    prior = PARAMS["likelihoodRatio"]["priorProbability"]
    posterior = prior*lr/(1-prior+prior*lr)
    ax.semilogx(lr, posterior, color=p["teal"], lw=2.4)
    ax.axhline(prior, color=p["muted"], ls=":", label="Prior probability = 0.20")
    ax.axvline(1, color=p["red"], ls="--", lw=1.2, label="LR = 1: odds unchanged")
    ax.scatter([1], [prior], color=p["red"], s=36, zorder=4)
    ax.set(xlabel="Conditional likelihood ratio (log scale)", ylabel="Posterior probability in the specified model", xlim=(.1,10), ylim=(0,1))
    ax.set_xticks([.1,.2,.5,1,2,5,10], ["0.1","0.2","0.5","1","2","5","10"])
    ax.set_title("Likelihood ratio is not a source-quality coefficient", color=p["ink"], loc="left", pad=16)
    finish(fig, ax, p, "likelihood-update", dark)

    fig, ax, p = canvas(dark)
    m = np.arange(1, PARAMS["candidateGrowth"]["maxRequirements"]+1)
    for k, color, style in zip(PARAMS["candidateGrowth"]["choicesPerRequirement"],[p["teal"],p["blue"],p["red"]],["-","--",":"]):
        ax.semilogy(m, k**m, color=color, ls=style, marker="o", ms=4, lw=2, label=f"{k} alternatives per requirement")
    ax.set(xlabel="Number of required conditions (m)", ylabel="Candidate combinations (log scale)", xticks=m)
    ax.set_title(r"Combinatorial growth: $|F(H)|=k^m$", color=p["ink"], loc="left", pad=16)
    finish(fig, ax, p, "candidate-growth", dark)

    fig, ax, p = canvas(dark)
    w = PARAMS["workedExample"]
    c1 = 1-(1-w["receipt"])*(1-w["independentReceipt"])
    values = [w["receipt"]*w["mapping"], c1*w["mapping"], c1*w["verifiedMapping"]]
    assert np.allclose(values, [.72,.78,.92625])
    ax.bar([1,2,3], values, width=.55, color=[p["red"],p["blue"],p["teal"]], zorder=3)
    ax.text(0,.08,"Not evaluated\n(missing E3)",ha="center",color=p["muted"],fontsize=10)
    for index, value in enumerate(values, start=1):
        ax.text(index,value+.025,f"{value:.5f}".rstrip("0"),ha="center",color=p["ink"],fontweight="bold")
    ax.axhline(w["threshold"],color=p["muted"],ls="--",label="Illustrative threshold = 0.80")
    ax.set(xticks=[0,1,2,3],xticklabels=["A\nMissing link","B\nMapping added","C\nNew observation","D\nOrigin verified"],ylabel="Support score under example assumptions",ylim=(0,1.12),xlim=(-.6,3.6))
    ax.set_title("Worked example · A is undefined, not zero",color=p["ink"],loc="left",pad=16)
    finish(fig, ax, p, "worked-example", dark)


for theme in [False, True]:
    render(theme)
print(f"Rendered 6 analytical figures × light SVG / dark SVG / PNG / PDF to {OUT}")
