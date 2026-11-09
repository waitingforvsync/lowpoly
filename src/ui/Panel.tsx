import type { ComponentChildren } from 'preact';

export function Panel({ title, children }: { title: string; children: ComponentChildren }) {
  return (
    <section class="panel">
      <h2 class="panel-title">{title}</h2>
      <div class="panel-body">{children}</div>
    </section>
  );
}

export function Empty({ children }: { children: ComponentChildren }) {
  return <p class="empty">{children}</p>;
}
