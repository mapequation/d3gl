import { createRoot } from "react-dom/client";
import { App } from "./App.js";

// No StrictMode: the engines create real WebGL/Canvas devices;
// StrictMode's dev double-mount would churn them needlessly.
createRoot(document.getElementById("root")!).render(<App />);
