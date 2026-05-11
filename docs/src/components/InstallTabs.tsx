import { useState } from "preact/hooks";

export interface InstallTab {
  label: string;
  url: string;
  storeName: string;
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
      <div class="px-4 py-4 flex items-center justify-between gap-4">
        <span class="text-[13px] text-[color:var(--color-ink-2)]">
          Margin for {current.label}, published on the {current.storeName}.
        </span>
        <a
          href={current.url}
          class="inline-flex items-center gap-2 rounded-md bg-[color:var(--color-ink)] text-white px-3 py-1.5 text-[13px] font-medium hover:bg-[color:var(--color-ink-2)] whitespace-nowrap"
        >
          Add to {current.label}
          <span aria-hidden="true">↗</span>
        </a>
      </div>
    </div>
  );
}
