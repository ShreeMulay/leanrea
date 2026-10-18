/** Pure grading: each key is a case-insensitive regex that must match the answer. */
export interface Grade {
  hits: Record<string, boolean>;
  score: string;
  points: number;
  total: number;
  miss: string[];
}

export function grade(answer: string, key: Readonly<Record<string, string>>): Grade {
  const hits: Record<string, boolean> = {};
  for (const [name, pattern] of Object.entries(key)) hits[name] = new RegExp(pattern, "i").test(answer);
  const names = Object.keys(hits);
  const points = names.filter((n) => hits[n]).length;
  return { hits, points, total: names.length, score: `${points}/${names.length}`, miss: names.filter((n) => !hits[n]) };
}
