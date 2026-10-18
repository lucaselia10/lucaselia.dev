import { documentPath } from "@career-portfolio/content";
import { formatDateSpan, formatEmployer } from "./format-dates";

/**
 * Pure layout for the "career as a capacity plan" chart and the role-page position strip.
 * Everything here is derived from reviewed front matter. Nothing is hand-positioned.
 */

export type LaneId = "aws" | "contract" | "small-business" | "education";

export type Lane = {
  id: LaneId;
  label: string;
};

/** Lane order is fixed: AWS, Contract, Small business, Education. */
export const LANES: readonly Lane[] = [
  { id: "aws", label: "AWS" },
  { id: "contract", label: "Contract" },
  { id: "small-business", label: "Small business" },
  { id: "education", label: "Education" },
];

export type ChartSource =
  | {
      id: string;
      type: "experience";
      visibility: string;
      role_title: string;
      employer: string;
      employment_type: string;
      start_date: string;
      end_date: string | null;
    }
  | {
      id: string;
      type: "background";
      visibility: string;
      institution: string;
      program: string;
      start_date: string;
      end_date: string;
    }
  | { id: string; type: "profile" | "project"; visibility: string };

export type ChartEntry = {
  id: string;
  href: string;
  lane: LaneId;
  start: string;
  end: string | null;
  /** Full name used for the accessible label. */
  name: string;
  /** Short visible label under the bar, without dates. */
  shortName: string;
  ariaLabel: string;
};

const AWS_EMPLOYERS = new Set(["Amazon Web Services", "AWS"]);
const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** Map one reviewed document to its lane. Unknown experience shapes fail the build. */
export function laneFor(source: ChartSource): LaneId | null {
  if (source.type === "background") {
    return "education";
  }
  if (source.type !== "experience") {
    return null;
  }
  if (AWS_EMPLOYERS.has(source.employer.trim())) {
    return "aws";
  }
  const employment = source.employment_type.trim().toLowerCase();
  if (employment === "contract") {
    return "contract";
  }
  if (employment === "self-employed") {
    return "small-business";
  }
  throw new Error(
    `Experience "${source.id}" does not map to a career-chart lane. Add a lane before publishing it.`,
  );
}

/** Build chart entries from public experience and education documents only. */
export function chartEntries(sources: readonly ChartSource[]): ChartEntry[] {
  const entries: ChartEntry[] = [];
  for (const source of sources) {
    if (source.visibility !== "public") {
      continue;
    }
    if (source.type === "experience") {
      const lane = laneFor(source);
      if (lane === null) {
        continue;
      }
      const employer = formatEmployer(source.employer);
      entries.push({
        id: source.id,
        href: documentPath("experience", source.id),
        lane,
        start: source.start_date,
        end: source.end_date,
        name: source.role_title,
        shortName: source.role_title,
        ariaLabel: `${source.role_title}, ${employer}, ${formatDateSpan(source.start_date, source.end_date)}`,
      });
    } else if (source.type === "background") {
      entries.push({
        id: source.id,
        href: documentPath("background", source.id),
        lane: "education",
        start: source.start_date,
        end: source.end_date,
        name: source.institution,
        shortName: source.institution,
        ariaLabel: `${source.program}, ${source.institution}, ${formatDateSpan(source.start_date, source.end_date)}`,
      });
    }
  }
  const sorted = entries.sort((left, right) =>
    left.start === right.start
      ? left.id.localeCompare(right.id)
      : left.start.localeCompare(right.start),
  );
  return shortenSharedTitles(sorted);
}

/**
 * Inside one lane, titles that share leading words keep only the last shared word,
 * so "Software Development Engineer II" becomes "Engineer II" beside its siblings.
 */
function shortenSharedTitles(entries: ChartEntry[]): ChartEntry[] {
  const byLane = new Map<LaneId, ChartEntry[]>();
  for (const entry of entries) {
    byLane.set(entry.lane, [...(byLane.get(entry.lane) ?? []), entry]);
  }
  const shortened = new Map<string, string>();
  for (const laneEntries of byLane.values()) {
    if (laneEntries.length < 2) {
      continue;
    }
    const words = laneEntries.map((entry) => entry.name.split(/\s+/));
    let shared = 0;
    while (
      words.every((title) => title.length > shared + 1) &&
      words.every((title) => title[shared] === words[0]?.[shared])
    ) {
      shared += 1;
    }
    if (shared < 2) {
      continue;
    }
    for (const [index, entry] of laneEntries.entries()) {
      shortened.set(entry.id, (words[index] ?? []).slice(shared - 1).join(" "));
    }
  }
  return entries.map((entry) => ({
    ...entry,
    shortName: shortened.get(entry.id) ?? entry.shortName,
  }));
}

/** "2023–2025", "2022" for a single year, or "2025 to now" for an open role. */
export function yearSpan(start: string, end: string | null): string {
  const startYear = start.slice(0, 4);
  if (end === null) {
    return `${startYear} to now`;
  }
  const endYear = end.slice(0, 4);
  return startYear === endYear ? startYear : `${startYear}–${endYear}`;
}

export function barLabel(entry: ChartEntry): string {
  return `${entry.shortName}, ${yearSpan(entry.start, entry.end)}`;
}

/** A stored YYYY-MM month as a fractional year at the start of that month. */
export function monthToYear(value: string): number {
  const match = MONTH.exec(value);
  if (!match) {
    throw new Error(`Expected a YYYY-MM month, received "${value}".`);
  }
  return Number(match[1]) + (Number(match[2]) - 1) / 12;
}

/** The build date as a fractional year (UTC). */
export function todayToYear(today: Date): number {
  const year = today.getUTCFullYear();
  const month = today.getUTCMonth();
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return year + (month + (today.getUTCDate() - 1) / daysInMonth) / 12;
}

export type ScaleSegment = { from: number; to: number; startPct: number; endPct: number };

export type TimeScale = {
  segments: readonly ScaleSegment[];
  /** The skipped stretch of years, drawn as a hatched band. */
  gap: { startPct: number; endPct: number; label: string } | null;
  domainStart: number;
  domainEnd: number;
};

/** Share of the width given to the early segment, the break, and the recent segment. */
export const SCALE_SHARES = { early: 34, gap: 4, recent: 62 } as const;
/** A coverage gap shorter than this is drawn to scale instead of being skipped. */
export const MIN_BREAK_YEARS = 3;

/**
 * A two-segment piecewise scale. The largest gap in the data, when it is long enough,
 * becomes a narrow break. Segment bounds round outward to whole or half years, and the
 * axis ends at the start of the year after the build date.
 */
export function createTimeScale(
  intervals: ReadonlyArray<{ start: number; end: number }>,
  today: number,
): TimeScale {
  if (intervals.length === 0) {
    throw new Error("The career chart needs at least one dated entry.");
  }
  const domainStart = Math.floor(Math.min(...intervals.map((interval) => interval.start)));
  const domainEnd = Math.floor(today) + 1;
  const gap = largestGap(intervals);
  if (gap === null || gap.to - gap.from < MIN_BREAK_YEARS) {
    return {
      segments: [{ from: domainStart, to: domainEnd, startPct: 0, endPct: 100 }],
      gap: null,
      domainStart,
      domainEnd,
    };
  }
  const earlyEnd = Math.ceil(gap.from * 2) / 2;
  const recentStart = Math.floor(gap.to * 2) / 2;
  const early = SCALE_SHARES.early;
  const recent = 100 - SCALE_SHARES.recent;
  const firstSkipped = Math.ceil(earlyEnd);
  const lastSkipped = Math.floor(recentStart) - 1;
  return {
    segments: [
      { from: domainStart, to: earlyEnd, startPct: 0, endPct: early },
      { from: recentStart, to: domainEnd, startPct: recent, endPct: 100 },
    ],
    gap: {
      startPct: early,
      endPct: recent,
      label: firstSkipped === lastSkipped ? `${firstSkipped}` : `${firstSkipped}–${lastSkipped}`,
    },
    domainStart,
    domainEnd,
  };
}

function largestGap(
  intervals: ReadonlyArray<{ start: number; end: number }>,
): { from: number; to: number } | null {
  const sorted = [...intervals].sort((left, right) => left.start - right.start);
  let coveredUntil = sorted[0]?.end ?? 0;
  let best: { from: number; to: number } | null = null;
  for (const interval of sorted.slice(1)) {
    if (interval.start > coveredUntil) {
      const candidate = { from: coveredUntil, to: interval.start };
      if (best === null || candidate.to - candidate.from > best.to - best.from) {
        best = candidate;
      }
    }
    coveredUntil = Math.max(coveredUntil, interval.end);
  }
  return best;
}

/** Map a fractional year to a percentage of the chart width. */
export function positionOf(scale: TimeScale, year: number): number {
  const first = scale.segments[0];
  const last = scale.segments[scale.segments.length - 1];
  if (!first || !last) {
    return 0;
  }
  if (year <= first.from) {
    return first.startPct;
  }
  if (year >= last.to) {
    return last.endPct;
  }
  for (const segment of scale.segments) {
    if (year >= segment.from && year <= segment.to) {
      const share = (year - segment.from) / (segment.to - segment.from);
      return segment.startPct + share * (segment.endPct - segment.startPct);
    }
  }
  // Inside the skipped stretch: place the point within the break band.
  const [early, recent] = scale.segments;
  if (!early || !recent) {
    return first.endPct;
  }
  const share = (year - early.to) / (recent.from - early.to);
  return early.endPct + share * (recent.startPct - early.endPct);
}

/** Year ticks closer than this to the break label are dropped. */
export const BREAK_CLEARANCE_PCT = 5;

export type Tick = { label: string; pct: number; kind: "year" | "break" };

/** Year ticks per segment (every 1, 2, or 5 years, whichever leaves room), plus the break. */
export function scaleTicks(scale: TimeScale): Tick[] {
  const ticks: Tick[] = [];
  for (const segment of scale.segments) {
    const pctPerYear = (segment.endPct - segment.startPct) / (segment.to - segment.from);
    const step = [1, 2, 5].find((candidate) => candidate * pctPerYear >= 6) ?? 10;
    const lastAllowed =
      segment === scale.segments[scale.segments.length - 1] ? segment.to - 0.4 : segment.to;
    for (let year = Math.ceil(segment.from); year <= lastAllowed; year += step) {
      ticks.push({ label: `${year}`, pct: positionOf(scale, year), kind: "year" });
    }
  }
  if (scale.gap) {
    const center = (scale.gap.startPct + scale.gap.endPct) / 2;
    // Year ticks right beside the break would collide with its label.
    const kept = ticks.filter((tick) => Math.abs(tick.pct - center) >= BREAK_CLEARANCE_PCT);
    kept.push({ label: scale.gap.label, pct: center, kind: "break" });
    return kept.sort((left, right) => left.pct - right.pct);
  }
  return ticks.sort((left, right) => left.pct - right.pct);
}

export type PlacedBar = ChartEntry & {
  left: number;
  width: number;
  /** True when the bar starts where another bar in its lane ends. */
  abutsPrevious: boolean;
  label: string;
};

export function placeBars(
  entries: readonly ChartEntry[],
  scale: TimeScale,
  today: number,
): PlacedBar[] {
  return entries.map((entry) => {
    const start = monthToYear(entry.start);
    const end = entry.end === null ? today : monthToYear(entry.end);
    const left = positionOf(scale, start);
    const right = positionOf(scale, end);
    const abutsPrevious = entries.some(
      (other) => other !== entry && other.lane === entry.lane && other.end === entry.start,
    );
    return {
      ...entry,
      left,
      width: Math.max(right - left, 0.4),
      abutsPrevious,
      label: barLabel(entry),
    };
  });
}

export type CareerChart = {
  scale: TimeScale;
  todayPct: number;
  ticks: Tick[];
  lanes: Array<Lane & { bars: PlacedBar[] }>;
};

/** Everything the chart and the position strip render, from documents and the build date. */
export function buildCareerChart(sources: readonly ChartSource[], today: Date): CareerChart {
  const entries = chartEntries(sources);
  const todayYear = todayToYear(today);
  const scale = createTimeScale(
    entries.map((entry) => ({
      start: monthToYear(entry.start),
      end: entry.end === null ? todayYear : monthToYear(entry.end),
    })),
    todayYear,
  );
  const bars = placeBars(entries, scale, todayYear);
  return {
    scale,
    todayPct: positionOf(scale, todayYear),
    ticks: scaleTicks(scale),
    lanes: LANES.map((lane) => ({
      ...lane,
      bars: bars.filter((bar) => bar.lane === lane.id),
    })).filter((lane) => lane.bars.length > 0),
  };
}

/** The narrowest rendered lane track: a 980px chart minus its 150px lane-name column. */
export const TRACK_MIN_PX = 830;
/** Estimated width of one label character at 13px and 78% width. */
export const LABEL_CHAR_PX = 6;
/** Inner padding on each side of a label drawn inside its bar. */
export const INSIDE_PADDING_PX = 8;
/**
 * Lanes whose color keeps #F5F7F9 label text at 4.5:1 or better (AWS 7.7:1, small
 * business 5.6:1). Contract (4.05:1) and Education (3.97:1) keep their labels below.
 */
export const INSIDE_LABEL_LANES: ReadonlySet<LaneId> = new Set(["aws", "small-business"]);
const BELOW_GAP_PCT = 1.5;

export type LabelPlacement = {
  id: string;
  text: string;
  position: "inside" | "below";
  align: "start" | "end";
  /** Distance from the left edge (start) or right edge (end), in percent of the track. */
  offsetPct: number;
};

function textWidthPct(text: string): number {
  return ((text.length * LABEL_CHAR_PX) / TRACK_MIN_PX) * 100;
}

/** True when the bar, at the narrowest rendered width, holds its label with padding. */
export function labelFitsInside(bar: PlacedBar): boolean {
  if (!INSIDE_LABEL_LANES.has(bar.lane)) {
    return false;
  }
  const barPx = (bar.width / 100) * TRACK_MIN_PX;
  return barPx >= bar.label.length * LABEL_CHAR_PX + 2 * INSIDE_PADDING_PX;
}

/**
 * Labels go inside a bar that can hold them. Every other label sits on one row below
 * the bars: never on a second line. A below label starts at its bar, or ends at its bar
 * when it would run past the right edge. If it would collide with another below label,
 * it drops its years; if that still collides, it is omitted (the bar keeps its
 * accessible name, and the role is listed in Experience).
 */
export function layoutHorizontalLabels(bars: readonly PlacedBar[]): LabelPlacement[] {
  const placements: LabelPlacement[] = [];
  const taken: Array<{ from: number; to: number }> = [];
  for (const bar of bars) {
    if (labelFitsInside(bar)) {
      placements.push({
        id: bar.id,
        text: bar.label,
        position: "inside",
        align: "start",
        offsetPct: bar.left,
      });
      continue;
    }
    for (const text of [bar.label, bar.shortName]) {
      const width = textWidthPct(text);
      const fitsStart = bar.left + width <= 100;
      const from = fitsStart ? bar.left : Math.max(0, bar.left + bar.width - width);
      const to = from + width;
      const clear = taken.every(
        (range) => to + BELOW_GAP_PCT <= range.from || from >= range.to + BELOW_GAP_PCT,
      );
      if (clear) {
        taken.push({ from, to });
        placements.push({
          id: bar.id,
          text,
          position: "below",
          align: fitsStart ? "start" : "end",
          offsetPct: fitsStart ? bar.left : 100 - (bar.left + bar.width),
        });
        break;
      }
    }
  }
  return placements;
}

/**
 * Vertical (phone) labels sit beside the top of each bar, where time runs downward.
 * A label may wrap; its height is estimated from its length. Labels never overlap and
 * stay inside the chart height.
 */
export function layoutVerticalLabels(
  bars: readonly PlacedBar[],
  heightPx: number,
  lineHeightPx: number,
  charsPerLine: number,
): Array<{ id: string; topPx: number; lines: number }> {
  const wanted = bars
    .map((bar) => ({
      id: bar.id,
      topPx: ((100 - (bar.left + bar.width)) / 100) * heightPx,
      lines: Math.max(1, Math.ceil(bar.label.length / Math.max(1, charsPerLine))),
    }))
    .sort((left, right) => left.topPx - right.topPx || left.id.localeCompare(right.id));
  for (let index = 1; index < wanted.length; index += 1) {
    const previous = wanted[index - 1];
    const current = wanted[index];
    if (previous && current) {
      current.topPx = Math.max(current.topPx, previous.topPx + previous.lines * lineHeightPx);
    }
  }
  for (let index = wanted.length - 1; index >= 0; index -= 1) {
    const current = wanted[index];
    if (!current) {
      continue;
    }
    const next = wanted[index + 1];
    const ceiling = (next ? next.topPx : heightPx) - current.lines * lineHeightPx;
    current.topPx = Math.max(0, Math.min(current.topPx, ceiling));
  }
  return wanted;
}
