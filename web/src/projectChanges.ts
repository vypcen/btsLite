import type { ProjectChange } from "./api";
import type { ProjectState } from "./types";

export type ProjectPart = Exclude<keyof ProjectState, "pid">;

const PARTS: Partial<Record<string, ProjectPart[]>> = {
  cases: ["cases", "runs", "results", "bugs", "attachments", "comments"],
  folders: ["folders", "cases"],
  runs: ["runs", "results", "bugs", "attachments", "comments"],
  runResults: ["runs", "results"],
  bugs: ["bugs", "results", "attachments", "comments"],
  comments: ["comments"],
  attachments: ["attachments"],
  plans: ["plans", "runs"],
  fields: ["customFields", "cases", "runs", "bugs"],
  autoruns: ["autoruns"],
  autotests: ["cases"],
  ci: [], requirements: [], templates: [], tracker: [], trash: [], webhooks: [],
};

export function partsFor(changes: ProjectChange[]) {
  const parts = new Set<ProjectPart>();
  const nums = new Set<number>();
  let allCasesOrResults = false;
  for (const { type, caseNum } of changes) {
    if (!Object.hasOwn(PARTS, type)) return {};
    const needed: readonly ProjectPart[] = type === "cases" && caseNum ? ["cases"] : PARTS[type]!;
    if ((type === "cases" || type === "runResults") && caseNum) nums.add(caseNum);
    else if (needed.includes("cases") || needed.includes("results")) allCasesOrResults = true;
    needed.forEach((p) => parts.add(p));
  }
  return { parts: [...parts], caseNums: allCasesOrResults || nums.size > 100 ? [] : [...nums] };
}
