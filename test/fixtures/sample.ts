interface Item {
  label: string;
  count: number;
}

export function summarize(items: readonly Item[]): {
  total: number;
  labels: string[];
} {
  let total: number = 0;
  const labels: string[] = [];

  for (const item of items) {
    total += item.count;
    labels.push(item.label);
  }

  return { total, labels };
}

const items: Item[] = [
  { label: "alpha", count: 3 },
  { label: "雪", count: 5 },
];

console.log(JSON.stringify(summarize(items)));

//# sourceMappingURL=sample.ts.map
