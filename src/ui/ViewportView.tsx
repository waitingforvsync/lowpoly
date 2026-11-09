import { useEffect, useRef } from 'preact/hooks';
import { Viewport } from '../render/Viewport';
import { attachViewport } from '../editor/viewActions';

export function ViewportView() {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const vp = new Viewport(ref.current!);
    attachViewport(vp);
    return () => {
      attachViewport(null);
      vp.dispose();
    };
  }, []);

  return <main class="viewport" ref={ref} />;
}
