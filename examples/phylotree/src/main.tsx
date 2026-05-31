import { createRoot } from "react-dom/client";
import { App } from "./App.js";

// No StrictMode: the plot() engine creates a real WebGL/Canvas device;
// StrictMode's dev double-mount would churn it needlessly.
createRoot(document.getElementById("root")!).render(<App />);
