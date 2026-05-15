import { Layout } from "./Layout.tsx";

export interface ReviewActionPageProps {
  title: string;
  body: string;
  tone: "ok" | "err";
}

export function ReviewActionPage(props: ReviewActionPageProps) {
  const toneClass = props.tone === "ok" ? "text-good" : "text-bad";
  return (
    <Layout title={`Margin — ${props.title}`}>
      <h1 class="font-display text-3xl leading-tight tracking-tight">{props.title}</h1>
      <p class={`mt-4 ${toneClass}`}>{props.body}</p>
      <p class="mt-10 pt-4 border-t border-rule text-xs text-muted">
        Margin · review action handler
      </p>
    </Layout>
  );
}
