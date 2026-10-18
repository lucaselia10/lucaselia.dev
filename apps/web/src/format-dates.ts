const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

/** Present a stored YYYY-MM fact as a month and year. Unknown values stay unchanged. */
export function formatMonthLabel(value: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(value);
  if (!match) {
    return value;
  }
  const month = Number(match[2]);
  if (month < 1 || month > 12) {
    return value;
  }
  return `${MONTHS[month - 1]} ${match[1]}`;
}

export function formatDateSpan(start: string, end: string | null): string {
  const endLabel = end === null ? "now" : formatMonthLabel(end);
  return `${formatMonthLabel(start)} to ${endLabel}`;
}

/** "Dec 2025" from a stored YYYY-MM month. Unknown values stay unchanged. */
export function formatShortMonth(value: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(value);
  const month = match ? Number(match[2]) : 0;
  if (!match || month < 1 || month > 12) {
    return value;
  }
  return `${(MONTHS[month - 1] ?? "").slice(0, 3)} ${match[1]}`;
}

/** "Mar 2023 to Dec 2025", or "Dec 2025 to now" for an open role. */
export function formatShortDateSpan(start: string, end: string | null): string {
  return `${formatShortMonth(start)} to ${end === null ? "now" : formatShortMonth(end)}`;
}

/** Join names as prose: "A", "A and B", or "A, B, and C". */
export function joinNames(names: readonly string[]): string {
  if (names.length <= 2) {
    return names.join(" and ");
  }
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1] ?? ""}`;
}

/** Stored employers separate several businesses with "|". Visitors read a plain list. */
export function formatEmployer(employer: string): string {
  return joinNames(
    employer
      .split("|")
      .map((name) => name.trim())
      .filter((name) => name !== ""),
  );
}

/** Format month-precision dates in displayed prose. This does not change stored facts. */
export function formatVisibleDates(text: string): string {
  return text.replace(/\b(\d{4})-(0[1-9]|1[0-2])\b/g, (match) => formatMonthLabel(match));
}
