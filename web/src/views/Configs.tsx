// При импорте старого проекта конфигурация остаётся видна в его прогонах.
export function ConfigChips({ cfg }: { cfg?: Record<string, string> | null }) {
  if (!cfg) return null;
  return <>{Object.entries(cfg).map(([group, option]) => <span key={group} className="chip" title={group}>{option}</span>)}</>;
}
