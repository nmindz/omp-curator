/** Left-aligned plain-text table; numeric columns (`align: "right"`) are right-aligned. */
export function table(header: string[], rows: string[][], align: Array<"left" | "right"> = []): string {
	const widths = header.map((cell, col) => Math.max(cell.length, ...rows.map(row => (row[col] ?? "").length)));
	const line = (cells: string[]) =>
		cells
			.map((cell, col) => (align[col] === "right" ? cell.padStart(widths[col]!) : cell.padEnd(widths[col]!)))
			.join("  ")
			.trimEnd();
	return [line(header), line(widths.map(width => "-".repeat(width))), ...rows.map(line)].join("\n");
}

export function day(iso: string | undefined): string {
	return iso ? iso.slice(0, 10) : "-";
}
