import { useState } from "preact/hooks";

export interface InstallTab {
  label: string;
  command: string;
}

interface Props {
  tabs: InstallTab[];
}

export default function InstallTabs({ tabs }: Props) {
  const [active, setActive] = useState(0);
  const current = tabs[active];

  return (
    <div class="my-4 rounded-lg border border-black/10 overflow-hidden bg-[color:var(--color-cream-2)]">
      <div role="tablist" class="flex border-b border-black/10 text-[13px]">
        {tabs.map((t, i) => {
          const isActive = i === active;
          return (
            <button
              key={t.label}
              type="button"
              role="tab"
              aria-selected={isActive}
              onClick={() => setActive(i)}
              class={
                "px-4 py-2 font-medium " +
                (isActive
                  ? "bg-[color:var(--color-ink)] text-white"
                  : "hover:bg-black/5")
              }
            >
              {t.label}
            </button>
          );
        })}
      </div>
      <pre class="px-4 py-3 font-mono text-[13px] whitespace-pre overflow-x-auto">
        <span class="text-[color:var(--color-muted)]">$</span> {current.command}
      </pre>
    </div>
  );
}
