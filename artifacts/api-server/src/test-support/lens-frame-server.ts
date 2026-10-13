// Test support for routes/teacher-lens.frame.test.ts: the API as its own
// process on a free port, so a test can kill it in the middle of a request the
// way a power cut or an OOM kill would.
import app from "../app";

const server = app.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (address && typeof address === "object") process.stdout.write(`LISTENING ${address.port}\n`);
});
