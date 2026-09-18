import type { KeyboardEvent } from "react";
import styles from "./settings.module.css";

export const SETTINGS_CATEGORIES = [
  {
    id: "orchestrator",
    title: "Orchestrator",
    description: "Capacity & scheduling",
  },
  {
    id: "agents",
    title: "Agent defaults",
    description: "Runtimes & permissions",
  },
  {
    id: "reviewer",
    title: "Reviewer",
    description: "General, prompts & learnings",
  },
] as const;
export type SettingsCategory = (typeof SETTINGS_CATEGORIES)[number]["id"];
const TABS = ["general", "prompts", "learnings"] as const;
export type ReviewerTab = (typeof TABS)[number];

export function ReviewerTabs({
  active,
  onChange,
}: {
  active: ReviewerTab;
  onChange: (tab: ReviewerTab) => void;
}) {
  function navigate(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const next =
      event.key === "ArrowRight"
        ? (index + 1) % TABS.length
        : event.key === "ArrowLeft"
          ? (index + TABS.length - 1) % TABS.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? TABS.length - 1
              : null;
    if (next === null) return;
    event.preventDefault();
    onChange(TABS[next]);
    document.getElementById(`tab-${TABS[next]}`)?.focus();
  }
  return (
    <div role="tablist" aria-label="Reviewer settings" className={styles.tabs}>
      {TABS.map((tab, index) => (
        <button
          key={tab}
          type="button"
          role="tab"
          id={`tab-${tab}`}
          aria-controls={`reviewer-${tab}`}
          aria-selected={active === tab}
          tabIndex={active === tab ? 0 : -1}
          onClick={() => onChange(tab)}
          onKeyDown={(event) => navigate(event, index)}
        >
          {tab[0].toUpperCase() + tab.slice(1)}
        </button>
      ))}
    </div>
  );
}
