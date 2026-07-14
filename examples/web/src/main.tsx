import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import RemeshStudio from "./remesh-studio";
import "./index.css";

createRoot(document.getElementById("root")!).render(
    <StrictMode>
        <RemeshStudio />
    </StrictMode>
);
