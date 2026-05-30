import { createRoot } from "react-dom/client";
import { App } from "./App.js";

// No StrictMode: the <D3GL> effect creates a real WebGL device; StrictMode's
// dev double-mount would churn it needlessly.
createRoot(document.getElementById("root")!).render(<App />);
