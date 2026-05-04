import { readFile } from "node:fs/promises";
import net from "node:net";
import { resolve } from "node:path";

export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT_FILE_NAME = "dev_current_port";

export function resolveWorkspace(inputCwd) {
  return resolve(inputCwd || process.env.CONSOLE_MONITOR_WORKSPACE || process.cwd());
}

export function resolvePortFile({ cwd, portFile } = {}) {
  if (portFile) {
    return resolve(portFile);
  }

  return resolve(resolveWorkspace(cwd), DEFAULT_PORT_FILE_NAME);
}

export async function readPort({ cwd, portFile } = {}) {
  const resolvedPortFile = resolvePortFile({ cwd, portFile });
  const rawPort = await readFile(resolvedPortFile, "utf8");
  const port = Number.parseInt(rawPort.trim(), 10);

  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid port in ${resolvedPortFile}: ${rawPort.trim()}`);
  }

  return {
    port,
    portFile: resolvedPortFile
  };
}

export async function sendConsoleRequest({
  cwd,
  portFile,
  host = DEFAULT_HOST,
  port,
  request,
  timeoutMs = 5000
}) {
  const resolved = port == null ? await readPort({ cwd, portFile }) : { port, portFile: null };

  return new Promise((resolvePromise, reject) => {
    const socket = net.createConnection({ host, port: resolved.port });
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Timed out connecting to console monitor on ${host}:${resolved.port}`));
    }, timeoutMs);

    let response = "";

    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(`${request}\n`);
      socket.end();
    });
    socket.on("data", (chunk) => {
      response += chunk;
    });
    socket.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    socket.on("close", () => {
      clearTimeout(timeout);
      resolvePromise({
        response,
        host,
        port: resolved.port,
        portFile: resolved.portFile
      });
    });
  });
}
