import type { IconName } from "../lib/icons";
import type { Step, StepState } from "../lib/pipeline";
import { Icon } from "./Icon";

const ICON: Record<StepState, IconName> = {
  done: "check",
  failed: "x",
  attention: "alert",
  running: "spinner",
  waiting: "clock",
  skipped: "minus",
  idle: "dot",
};

export function Stepper({ steps }: { steps: Step[] }) {
  return (
    <ol className="stepper" aria-label="배포 단계">
      {steps.map((step) => (
        <li key={step.key} className={`step state-${step.state}`}>
          <span className="step-mark">
            <Icon name={ICON[step.state]} size={14} />
          </span>
          <span className="step-text">
            <span className="step-label">{step.label}</span>
            <span className="step-note">{step.note}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}
