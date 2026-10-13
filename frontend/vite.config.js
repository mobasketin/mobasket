import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
import path from "path"
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

export default defineConfig({
    plugins: [react(), tailwindcss()],
    resolve: {
        alias: {
            "@": path.resolve(__dirname, "./src"),
        },
        dedupe: ["react", "react-dom"],
    },
    optimizeDeps: {
        include: [
            "@emotion/react",
            "@emotion/styled",
            "@mui/material",
            "@mui/x-date-pickers",
        ],
    },
    server: {
        host: "0.0.0.0",
        port: 5173,
    },
});                                                                                                   