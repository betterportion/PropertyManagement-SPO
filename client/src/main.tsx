import { createRoot } from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import "./index.css";

// Outermost boundary. This one catches crashes in the providers themselves --
// theming, routing, the query client -- which are mounted above every
// in-app boundary and would otherwise blank the screen.
createRoot(document.getElementById("root")!).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
);
