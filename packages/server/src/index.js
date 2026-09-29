import { startServer } from "./server.js";

const { server } = startServer();
console.log(`rebendei listening on http://localhost:${server.port}`);
