import React from "react";
import ReactDOM from "react-dom/client";
import Lenis, { type LenisOptions } from "lenis";
import { App } from "./App";
import { initSentry } from "./sentry";
import "lenis/dist/lenis.css";
import "./index.css";

initSentry();

const lenisOptions: LenisOptions = {
  autoRaf: true,
  anchors: true,
  overscroll: false,
  prevent: (node) => Boolean(node.closest(".dashboard-page"))
};

function SmoothScrollProvider({ children }: { children: React.ReactNode }) {
  React.useEffect(() => {
    const lenis = new Lenis(lenisOptions);

    return () => {
      lenis.destroy();
    };
  }, []);

  return <>{children}</>;
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <SmoothScrollProvider>
      <App />
    </SmoothScrollProvider>
  </React.StrictMode>
);
