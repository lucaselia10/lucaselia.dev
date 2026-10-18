import { describe, expect, it } from "vitest";
import {
  BREAK_CLEARANCE_PCT,
  buildCareerChart,
  chartEntries,
  createTimeScale,
  laneFor,
  LABEL_CHAR_PX,
  labelFitsInside,
  layoutHorizontalLabels,
  layoutVerticalLabels,
  monthToYear,
  placeBars,
  positionOf,
  scaleTicks,
  TRACK_MIN_PX,
  todayToYear,
  yearSpan,
  type ChartSource,
} from "./career-chart";
import { formatEmployer, formatShortDateSpan } from "./format-dates";

const TODAY = new Date(Date.UTC(2026, 9, 8));

function experience(
  id: string,
  start: string,
  end: string | null,
  overrides: Partial<Extract<ChartSource, { type: "experience" }>> = {},
): ChartSource {
  return {
    id,
    type: "experience",
    visibility: "public",
    role_title: `Role ${id}`,
    employer: "Amazon Web Services",
    employment_type: "Full-time",
    start_date: start,
    end_date: end,
    ...overrides,
  };
}

function education(id: string, start: string, end: string): ChartSource {
  return {
    id,
    type: "background",
    visibility: "public",
    institution: `School ${id}`,
    program: "Program",
    start_date: start,
    end_date: end,
  };
}

// The same shape as the reviewed corpus: an early stretch, a long gap, and recent roles.
const CORPUS: ChartSource[] = [
  education("sierra", "2006-08", "2008-05"),
  experience("cofounder", "2008-06", "2014-04", {
    employer: "Bloom Coffee & Tea | Pause Lounge & Kitchen | Broadacre Coffee",
    employment_type: "Self-employed",
    role_title: "Co-Founder",
  }),
  education("bloomtech", "2021-10", "2022-08"),
  experience("contract", "2022-06", "2022-10", {
    employer: "Expert Assist",
    employment_type: "Contract",
  }),
  experience("apprentice", "2022-09", "2023-03", {
    role_title: "Software Development Engineer Apprentice",
  }),
  experience("sde-i", "2023-03", "2025-12", { role_title: "Software Development Engineer I" }),
  experience("sde-ii", "2025-12", null, { role_title: "Software Development Engineer II" }),
];

function corpusScale() {
  const today = todayToYear(TODAY);
  const entries = chartEntries(CORPUS);
  return {
    today,
    entries,
    scale: createTimeScale(
      entries.map((entry) => ({
        start: monthToYear(entry.start),
        end: entry.end === null ? today : monthToYear(entry.end),
      })),
      today,
    ),
  };
}

describe("two-segment time scale", () => {
  it("derives the break from the largest coverage gap and rounds to half years", () => {
    const { scale } = corpusScale();

    expect(scale.segments).toEqual([
      { from: 2006, to: 2014.5, startPct: 0, endPct: 34 },
      { from: 2021.5, to: 2027, startPct: 38, endPct: 100 },
    ]);
    expect(scale.gap).toEqual({ startPct: 34, endPct: 38, label: "2015–2020" });
  });

  it("maps years linearly inside each segment", () => {
    const { scale } = corpusScale();

    expect(positionOf(scale, 2006)).toBe(0);
    expect(positionOf(scale, 2008)).toBeCloseTo(8, 5);
    expect(positionOf(scale, 2014.5)).toBeCloseTo(34, 5);
    expect(positionOf(scale, 2021.5)).toBeCloseTo(38, 5);
    expect(positionOf(scale, 2022)).toBeCloseTo(43.636, 2);
    expect(positionOf(scale, 2027)).toBe(100);
  });

  it("places a point inside the skipped years within the break band and clamps the ends", () => {
    const { scale } = corpusScale();
    const inside = positionOf(scale, 2018);

    expect(inside).toBeGreaterThan(34);
    expect(inside).toBeLessThan(38);
    expect(positionOf(scale, 1990)).toBe(0);
    expect(positionOf(scale, 2040)).toBe(100);
  });

  it("is increasing across the whole domain", () => {
    const { scale } = corpusScale();
    let previous = -1;
    for (let year = 2006; year <= 2027; year += 0.25) {
      const position = positionOf(scale, year);
      expect(position).toBeGreaterThanOrEqual(previous);
      previous = position;
    }
  });

  it("draws a short gap to scale instead of skipping it", () => {
    const scale = createTimeScale(
      [
        { start: 2018, end: 2019 },
        { start: 2020.5, end: 2026 },
      ],
      2026.5,
    );

    expect(scale.gap).toBeNull();
    expect(scale.segments).toEqual([{ from: 2018, to: 2027, startPct: 0, endPct: 100 }]);
    expect(positionOf(scale, 2022.5)).toBeCloseTo(50, 5);
  });
});

describe("today position", () => {
  it("turns the build date into a fractional year", () => {
    expect(todayToYear(new Date(Date.UTC(2026, 0, 1)))).toBe(2026);
    expect(todayToYear(TODAY)).toBeCloseTo(2026 + (9 + 7 / 31) / 12, 6);
  });

  it("sits near the right edge of the recent segment", () => {
    const chart = buildCareerChart(CORPUS, TODAY);

    expect(chart.todayPct).toBeCloseTo(97.41, 1);
    const current = chart.lanes.flatMap((lane) => lane.bars).find((bar) => bar.id === "sde-ii");
    expect(current && current.left + current.width).toBeCloseTo(chart.todayPct, 5);
  });
});

describe("lane mapping", () => {
  it("maps employer, employment type, and education to lanes", () => {
    expect(laneFor(experience("a", "2023-01", null))).toBe("aws");
    expect(
      laneFor(
        experience("b", "2022-01", "2022-02", {
          employer: "Expert Assist",
          employment_type: "Contract",
        }),
      ),
    ).toBe("contract");
    expect(
      laneFor(
        experience("c", "2010-01", "2011-01", {
          employer: "Cafe",
          employment_type: "Self-employed",
        }),
      ),
    ).toBe("small-business");
    expect(laneFor(education("d", "2006-01", "2007-01"))).toBe("education");
    expect(laneFor({ id: "e", type: "project", visibility: "public" })).toBeNull();
  });

  it("refuses an experience that has no lane instead of dropping it", () => {
    expect(() =>
      laneFor(
        experience("x", "2020-01", null, { employer: "Elsewhere", employment_type: "Full-time" }),
      ),
    ).toThrow(/does not map to a career-chart lane/);
  });

  it("orders lanes AWS, Contract, Small business, Education", () => {
    const chart = buildCareerChart(CORPUS, TODAY);

    expect(chart.lanes.map((lane) => lane.label)).toEqual([
      "AWS",
      "Contract",
      "Small business",
      "Education",
    ]);
  });

  it("leaves out projects, drafts, and the fictional fixture", () => {
    const entries = chartEntries([
      ...CORPUS,
      { id: "fictional-lumen-harbor", type: "project", visibility: "public" },
      { ...experience("draft-role", "2024-01", null), visibility: "draft" },
    ]);
    const ids = entries.map((entry) => entry.id);

    expect(ids).not.toContain("fictional-lumen-harbor");
    expect(ids).not.toContain("draft-role");
    expect(ids).toHaveLength(CORPUS.length);
  });
});

describe("bars and labels", () => {
  it("links each bar to its role page with role and dates in the accessible name", () => {
    const entries = chartEntries(CORPUS);
    const current = entries.find((entry) => entry.id === "sde-ii");
    const cofounder = entries.find((entry) => entry.id === "cofounder");

    expect(current?.href).toBe("/experience/sde-ii");
    expect(current?.ariaLabel).toBe(
      "Software Development Engineer II, Amazon Web Services, December 2025 to now",
    );
    expect(cofounder?.ariaLabel).toBe(
      "Co-Founder, Bloom Coffee & Tea, Pause Lounge & Kitchen, and Broadacre Coffee, June 2008 to April 2014",
    );
    expect(entries.find((entry) => entry.id === "bloomtech")?.href).toBe("/background/bloomtech");
  });

  it("shortens titles that share leading words within a lane", () => {
    const names = chartEntries(CORPUS)
      .filter((entry) => entry.lane === "aws")
      .map((entry) => entry.shortName);

    expect(names).toEqual(["Engineer Apprentice", "Engineer I", "Engineer II"]);
  });

  it("writes year spans for closed, single-year, and open roles", () => {
    expect(yearSpan("2023-03", "2025-12")).toBe("2023–2025");
    expect(yearSpan("2022-06", "2022-10")).toBe("2022");
    expect(yearSpan("2025-12", null)).toBe("2025 to now");
  });

  it("marks a bar that starts where another in its lane ends", () => {
    const { entries, scale, today } = corpusScale();
    const bars = placeBars(entries, scale, today);

    expect(bars.find((bar) => bar.id === "sde-ii")?.abutsPrevious).toBe(true);
    expect(bars.find((bar) => bar.id === "apprentice")?.abutsPrevious).toBe(false);
  });

  it("puts a label inside a bar only when it fits and the lane color keeps 4.5:1 text", () => {
    const { entries, scale, today } = corpusScale();
    const bars = placeBars(entries, scale, today);
    const bar = (id: string) => {
      const found = bars.find((candidate) => candidate.id === id);
      if (!found) {
        throw new Error(id);
      }
      return found;
    };

    // Engineer I spans about 31% (257px at the 830px minimum): "Engineer I, 2023–2025" fits.
    expect(labelFitsInside(bar("sde-i"))).toBe(true);
    // Co-Founder spans about 23% (193px) and the olive lane keeps 5.6:1 text.
    expect(labelFitsInside(bar("cofounder"))).toBe(true);
    // Engineer II spans under 10% (80px): its label stays below.
    expect(labelFitsInside(bar("sde-ii"))).toBe(false);
    // A bar wide enough on a light lane still keeps its label below for contrast.
    const wideContract = { ...bar("contract"), width: 60 };
    expect((wideContract.width / 100) * TRACK_MIN_PX).toBeGreaterThan(
      wideContract.label.length * LABEL_CHAR_PX,
    );
    expect(labelFitsInside(wideContract)).toBe(false);
  });

  it("keeps below labels on one row without collisions and drops nothing", () => {
    const chart = buildCareerChart(CORPUS, TODAY);
    for (const lane of chart.lanes) {
      const labels = layoutHorizontalLabels(lane.bars);
      expect(labels.map((label) => label.id).sort()).toEqual(lane.bars.map((bar) => bar.id).sort());
      const below = labels
        .filter((label) => label.position === "below")
        .map((label) => {
          const width = ((label.text.length * LABEL_CHAR_PX) / TRACK_MIN_PX) * 100;
          const from = label.align === "start" ? label.offsetPct : 100 - label.offsetPct - width;
          return { from, to: from + width };
        })
        .sort((left, right) => left.from - right.from);
      for (let index = 1; index < below.length; index += 1) {
        expect(below[index]?.from).toBeGreaterThanOrEqual(below[index - 1]?.to ?? 0);
      }
      for (const range of below) {
        expect(range.from).toBeGreaterThanOrEqual(0);
        expect(range.to).toBeLessThanOrEqual(100.001);
      }
    }

    const aws = chart.lanes.find((lane) => lane.id === "aws");
    const placements = layoutHorizontalLabels(aws?.bars ?? []);
    expect(placements.map((label) => [label.id, label.position, label.align])).toEqual([
      ["apprentice", "below", "start"],
      ["sde-i", "inside", "start"],
      ["sde-ii", "below", "end"],
    ]);
  });

  it("shortens, then omits, a below label that would collide", () => {
    const { entries, scale, today } = corpusScale();
    const bars = placeBars(entries, scale, today).filter((bar) => bar.lane === "education");
    const base = bars[0];
    if (!base) {
      throw new Error("education bar missing");
    }
    const crowded = [
      { ...base, id: "x", left: 70, width: 2, label: "Xray, 2024", shortName: "Xray" },
      // The full label must right-align and would reach back into "Xray"; the short one fits.
      {
        ...base,
        id: "y",
        left: 95,
        width: 3,
        label: "A fairly long label here, 2025",
        shortName: "Yankee",
      },
      // Starts under "Xray": neither form fits, so it is omitted rather than stacked.
      { ...base, id: "z", left: 71, width: 1, label: "Zulu, 2024", shortName: "Zulu" },
    ];
    const placements = layoutHorizontalLabels(crowded);

    expect(placements.find((label) => label.id === "x")?.text).toBe("Xray, 2024");
    expect(placements.find((label) => label.id === "y")).toMatchObject({
      text: "Yankee",
      align: "start",
    });
    expect(placements.find((label) => label.id === "z")).toBeUndefined();
    expect(placements.every((label) => label.position === "below")).toBe(true);
  });

  it("keeps vertical labels apart and inside the chart height", () => {
    const chart = buildCareerChart(CORPUS, TODAY);
    const bars = chart.lanes.flatMap((lane) => lane.bars);
    const labels = layoutVerticalLabels(bars, 720, 16, 22);

    for (let index = 1; index < labels.length; index += 1) {
      const previous = labels[index - 1];
      const current = labels[index];
      if (previous && current) {
        expect(current.topPx).toBeGreaterThanOrEqual(previous.topPx + previous.lines * 16);
      }
    }
    for (const label of labels) {
      expect(label.topPx).toBeGreaterThanOrEqual(0);
      expect(label.topPx + label.lines * 16).toBeLessThanOrEqual(720);
    }
  });
});

describe("axis ticks", () => {
  it("uses two-year steps early, yearly steps late, and keeps clear of the break", () => {
    const { scale } = corpusScale();
    const ticks = scaleTicks(scale);
    const labels = ticks.map((tick) => tick.label);

    expect(labels).toEqual([
      "2006",
      "2008",
      "2010",
      "2012",
      "2015–2020",
      "2022",
      "2023",
      "2024",
      "2025",
      "2026",
    ]);
    const gapTick = ticks.find((tick) => tick.kind === "break");
    for (const tick of ticks.filter((candidate) => candidate.kind === "year")) {
      expect(Math.abs(tick.pct - (gapTick?.pct ?? 0))).toBeGreaterThanOrEqual(BREAK_CLEARANCE_PCT);
    }
  });
});

describe("visitor-facing formats", () => {
  it("lists several employers as prose and writes short date spans", () => {
    expect(formatEmployer("Bloom Coffee & Tea | Pause Lounge & Kitchen | Broadacre Coffee")).toBe(
      "Bloom Coffee & Tea, Pause Lounge & Kitchen, and Broadacre Coffee",
    );
    expect(formatEmployer("A | B")).toBe("A and B");
    expect(formatEmployer("Amazon Web Services")).toBe("Amazon Web Services");
    expect(formatShortDateSpan("2025-12", null)).toBe("Dec 2025 to now");
    expect(formatShortDateSpan("2023-03", "2025-12")).toBe("Mar 2023 to Dec 2025");
  });
});
