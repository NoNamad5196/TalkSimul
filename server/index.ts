import dotenv from "dotenv";
import { createApp } from "./app.js";

dotenv.config({ quiet: true });
const server = createApp().listen(3001, "127.0.0.1", () => {
  console.log("TalkSimul local server: http://127.0.0.1:3001");
});
server.on("error", (error: NodeJS.ErrnoException) => {
  console.error(
    error.code === "EADDRINUSE"
      ? "TalkSimul: port 3001 is already in use."
      : "TalkSimul: local server could not start.",
  );
  process.exitCode = 1;
});
const close = () => {
  server.close(() => process.exit(0));
};
process.once("SIGINT", close);
process.once("SIGTERM", close);
