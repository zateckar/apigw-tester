import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  AreaChart, Area, LineChart, Line, BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend
} from "recharts";

/**
 * Panel: measures its own box with ResizeObserver once, then renders a Recharts
 * SVG with explicit pixel width/height. Complately avoids ResponsiveContainer's
 * measurement loop (the class .doubling-per-poll bug that grows the page).
 */
export function Panel({ children, height = 240 }: {
  children: (dims: { width: number; height: number }) => ReactNode;
  height?: number;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [w, setW] = useState(640); // sane initial guess; observer overrides on mount
  useEffect(() => {
    if (!ref.current) return;
    const el = ref.current;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) {
        const cw = Math.floor(e.contentRect.width);
        if (cw > 0) setW(cw);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <div ref={ref} style={{ width: "100%", height, overflow: "hidden" }}>
      {children({ width: w, height })}
    </div>
  );
}

// Recharts building blocks we re-export so views import from one place.
export {
  AreaChart, Area, LineChart, Line, BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend
};
