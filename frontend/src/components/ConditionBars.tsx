import type { TestCondition } from "../api/types";

const LABEL: Record<TestCondition["name"], string> = {
  none: "그대로 (none)",
  restart: "재시작 (restart)",
  replace: "교체 (replace)",
};

export function ConditionBars({ conditions }: { conditions: TestCondition[] }) {
  return (
    <div className="bars">
      {conditions.map((condition) => {
        const ratio = condition.total ? condition.matched / condition.total : 0;
        return (
          <div key={condition.name} className={`bar-row ${condition.failed ? "is-failed" : ""}`}>
            <span className="bar-label">{LABEL[condition.name] ?? condition.name}</span>
            <span
              className="bar-track"
              role="meter"
              aria-valuemin={0}
              aria-valuemax={condition.total}
              aria-valuenow={condition.matched}
              aria-label={`${condition.name} 일치 ${condition.matched}/${condition.total}`}
            >
              <span className="bar-fill" style={{ width: `${ratio * 100}%` }} />
            </span>
            <span className="bar-value">
              {condition.matched}/{condition.total}
            </span>
          </div>
        );
      })}
    </div>
  );
}
