import { useEffect, useState } from "react";

/** True while the strip has keys past its right edge, for the fade. */
export function useMoreToRight(el: React.RefObject<HTMLDivElement | null>, active: boolean) {
  const [more, setMore] = useState(false);
  useEffect(() => {
    const node = el.current;
    if (!node || !active) {
      setMore(false);
      return;
    }
    const measure = () =>
      setMore(node.scrollLeft + node.clientWidth < node.scrollWidth - 1);
    measure();
    node.addEventListener("scroll", measure, { passive: true });
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => {
      node.removeEventListener("scroll", measure);
      observer.disconnect();
    };
  }, [el, active]);
  return more;
}
