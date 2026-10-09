import { createApp } from "../server/app.js";

// Vercel serves the Vite output through its CDN and invokes this function for /api/*.
export default createApp({ staticDir: false });
