#!/usr/bin/env node

const { readFileSync, unlinkSync, writeFileSync } = require("node:fs");
const net = require("node:net");
const { spawn } = require("node:child_process");
const { resolve } = require("node:path");

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 7777;
const DEFAULT_READ_LINES = 10;
const HISTORY_LIMIT = 100;
const RESTART_FORCE_KILL_TIMEOUT_MS = 5000;
const CURRENT_PORT_FILE = resolve(__dirname, "..", "dev_current_port");

function printUsage() {
  console.error(
    [
      "Usage:",
      "  node scripts/run_bash.js [--port <number>] [--host <host>] [--cwd <path>] -- <command> [args...]",
      "  node scripts/run_bash.js [--port <number>] [--host <host>] [--cwd <path>] <command> [args...]",
      "",
      "TCP protocol:",
      `  - TCP starts by default on ${DEFAULT_HOST}:${DEFAULT_PORT}.`,
      "  - If the requested TCP port is busy, the script tries the next port until it finds one.",
      `  - The active TCP port is written to ${CURRENT_PORT_FILE}.`,
      `  - Connect to the active port and send 'read()' or 'read(<n>)' followed by a newline.`,
      `  - 'read()' returns the last ${DEFAULT_READ_LINES} lines.`,
      "  - Send 'restart()' to clear the history and restart the wrapped command.",
      `  - The in-memory history keeps at most the last ${HISTORY_LIMIT} lines.`,
      "",
      "Examples:",
      "  node scripts/run_bash.js -- pnpm dev",
      `  printf 'read(25)\\n' | nc ${DEFAULT_HOST} ${DEFAULT_PORT}`,
      `  printf 'restart()\\n' | nc ${DEFAULT_HOST} ${DEFAULT_PORT}`,
      "  node scripts/run_bash.js --port 4010 -- pnpm dev"
    ].join("\n")
  );
}

function parsePositiveInteger(value, flagName) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid value for ${flagName}: ${value}`);
  }
  return parsed;
}

function parseArgs(argv) {
  const options = {
    host: DEFAULT_HOST,
    cwd: process.cwd(),
    port: DEFAULT_PORT
  };

  const command = [];
  let parsingFlags = true;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (parsingFlags && token === "--") {
      parsingFlags = false;
      continue;
    }

    if (parsingFlags && token === "--help") {
      options.help = true;
      continue;
    }

    if (parsingFlags && token.startsWith("--port=")) {
      options.port = parsePositiveInteger(token.slice("--port=".length), "--port");
      continue;
    }

    if (parsingFlags && token === "--port") {
      index += 1;
      if (index >= argv.length) {
        throw new Error("Missing value for --port");
      }
      options.port = parsePositiveInteger(argv[index], "--port");
      continue;
    }

    if (parsingFlags && token.startsWith("--host=")) {
      options.host = token.slice("--host=".length) || DEFAULT_HOST;
      continue;
    }

    if (parsingFlags && token === "--host") {
      index += 1;
      if (index >= argv.length) {
        throw new Error("Missing value for --host");
      }
      options.host = argv[index] || DEFAULT_HOST;
      continue;
    }

    if (parsingFlags && token.startsWith("--cwd=")) {
      options.cwd = resolve(token.slice("--cwd=".length));
      continue;
    }

    if (parsingFlags && token === "--cwd") {
      index += 1;
      if (index >= argv.length) {
        throw new Error("Missing value for --cwd");
      }
      options.cwd = resolve(argv[index]);
      continue;
    }

    command.push(token);
  }

  return {
    options,
    command
  };
}

function writeSocketText(socket, text) {
  try {
    socket.write(text);
  } catch (error) {
    socket.destroy(error);
  }
}

function clampReadAmount(requested) {
  return Math.min(Math.max(requested, 0), HISTORY_LIMIT);
}

function readAmountFromRequest(parsed) {
  if (parsed.offset == null) {
    return DEFAULT_READ_LINES;
  }

  return clampReadAmount(parsePositiveInteger(parsed.offset, "offset"));
}

function parseTcpRequest(rawRequest) {
  const request = rawRequest.trim();

  if (!request) {
    return null;
  }

  if (request.startsWith("{")) {
    const parsed = JSON.parse(request);

    if (parsed?.method === "read") {
      return {
        type: "read",
        amount: readAmountFromRequest(parsed)
      };
    }

    if (parsed?.method === "restart") {
      return {
        type: "restart"
      };
    }

    throw new Error("Unsupported JSON method");
  }

  const readMatch = /^read(?:\((\d*)\))?$/.exec(request);
  if (readMatch) {
    if (readMatch[1] == null || readMatch[1] === "") {
      return {
        type: "read",
        amount: DEFAULT_READ_LINES
      };
    }

    return {
      type: "read",
      amount: clampReadAmount(parsePositiveInteger(readMatch[1], "offset"))
    };
  }

  if (request === "restart()") {
    return {
      type: "restart"
    };
  }

  throw new Error("Unsupported command. Use read(), read(<n>) or restart()");
}

function createHistoryWindow() {
  const lines = [];

  return {
    push(entry) {
      lines.push(entry);
      if (lines.length > HISTORY_LIMIT) {
        lines.splice(0, lines.length - HISTORY_LIMIT);
      }
    },
    read(count) {
      return lines.slice(-count);
    },
    clear() {
      lines.length = 0;
    },
    size() {
      return lines.length;
    }
  };
}

function consumeBufferedText(buffer, chunk, onLine) {
  const combined = buffer + chunk;
  const parts = combined.split(/\r\n|[\n\r]/);
  const endsWithLineBreak = /(?:\r\n|[\n\r])$/.test(combined);
  const completeLineCount = parts.length - 1;

  for (let index = 0; index < completeLineCount; index += 1) {
    onLine(parts[index]);
  }

  return endsWithLineBreak ? "" : parts[parts.length - 1];
}

function main() {
  let parsed;

  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`[run_bash] ${error.message}`);
    printUsage();
    process.exit(1);
  }

  if (parsed.options.help) {
    printUsage();
    process.exit(0);
  }

  if (parsed.command.length === 0) {
    console.error("[run_bash] Missing command");
    printUsage();
    process.exit(1);
  }

  const [command, ...args] = parsed.command;
  const history = createHistoryWindow();
  const tcpClients = new Set();
  const streamBuffers = {
    stdout: "",
    stderr: ""
  };
  const configuredPort = parsed.options.port;
  const configuredHost = parsed.options.host;
  const SERVER_STARTUP_CANCELLED = "SERVER_STARTUP_CANCELLED";

  let server = null;
  let activePort = configuredPort;
  let child = null;
  let childPendingRestart = null;
  let ownsCurrentPortFile = false;
  let isServerStartupCancelled = false;
  let isRestartInProgress = false;

  function writeCurrentPortFile(port) {
    writeFileSync(CURRENT_PORT_FILE, `${port}\n`, "utf8");
    ownsCurrentPortFile = true;
  }

  function clearCurrentPortFile() {
    if (!ownsCurrentPortFile) {
      return;
    }

    try {
      const currentPort = readFileSync(CURRENT_PORT_FILE, "utf8").trim();
      if (currentPort === String(activePort)) {
        unlinkSync(CURRENT_PORT_FILE);
      }
    } catch (error) {
      if (error?.code !== "ENOENT") {
        console.error(`[run_bash] Failed to clear ${CURRENT_PORT_FILE}: ${error.message}`);
      }
    } finally {
      ownsCurrentPortFile = false;
    }
  }

  function broadcast(payload) {
    for (const socket of tcpClients) {
      writeSocketText(socket, payload);
    }
  }

  function rememberLine(line) {
    history.push(line);
  }

  function writeHistory(socket, count) {
    const lines = history.read(count);
    if (lines.length === 0) {
      return;
    }

    writeSocketText(socket, `${lines.join("\n")}\n`);
  }

  function handleChunk(source, chunk) {
    const text = chunk.toString("utf8");
    const target = source === "stdout" ? process.stdout : process.stderr;

    target.write(text);
    streamBuffers[source] = consumeBufferedText(streamBuffers[source], text, (line) => {
      rememberLine(line);
    });
    broadcast(text);
  }

  function flushPartialLines() {
    for (const source of Object.keys(streamBuffers)) {
      const remainder = streamBuffers[source];
      if (!remainder) {
        continue;
      }

      rememberLine(remainder);
      streamBuffers[source] = "";
    }
  }

  function clearHistoryAndBuffers() {
    history.clear();

    for (const source of Object.keys(streamBuffers)) {
      streamBuffers[source] = "";
    }
  }

  function closeServerAndClients() {
    isServerStartupCancelled = true;
    clearCurrentPortFile();

    for (const socket of tcpClients) {
      socket.end();
      socket.destroy();
    }
    tcpClients.clear();

    if (server) {
      server.close();
      server = null;
    }
  }

  function createServerStartupCancelledError() {
    const error = new Error("TCP server startup cancelled");
    error.code = SERVER_STARTUP_CANCELLED;
    return error;
  }

  function killCurrentChild(signal) {
    const targetChild = child ?? childPendingRestart;
    if (targetChild && !targetChild.killed) {
      targetChild.kill(signal);
    }
  }

  function startChildProcess() {
    const childProcess = spawn(command, args, {
      cwd: parsed.options.cwd,
      env: process.env,
      stdio: ["inherit", "pipe", "pipe"],
      shell: process.platform === "win32"
    });

    child = childProcess;

    if (childProcess.stdout) {
      childProcess.stdout.on("data", (chunk) => {
        if (childProcess === child) {
          handleChunk("stdout", chunk);
        }
      });
    }

    if (childProcess.stderr) {
      childProcess.stderr.on("data", (chunk) => {
        if (childProcess === child) {
          handleChunk("stderr", chunk);
        }
      });
    }

    childProcess.on("error", (error) => {
      if (childProcess !== child) {
        return;
      }

      console.error(`[run_bash] Failed to start child process: ${error.message}`);
      closeServerAndClients();
      process.exit(1);
    });

    childProcess.on("exit", (code, signal) => {
      if (childProcess !== child) {
        return;
      }

      flushPartialLines();
      closeServerAndClients();

      if (signal) {
        process.kill(process.pid, signal);
        return;
      }

      process.exit(code ?? 1);
    });
  }

  function restartChildProcess() {
    clearHistoryAndBuffers();

    if (isRestartInProgress) {
      return false;
    }

    isRestartInProgress = true;

    const childToRestart = child;
    child = null;
    childPendingRestart = childToRestart;

    function startReplacement() {
      if (!isRestartInProgress) {
        return;
      }

      if (childPendingRestart === childToRestart) {
        childPendingRestart = null;
      }

      isRestartInProgress = false;

      if (!isServerStartupCancelled) {
        startChildProcess();
      }
    }

    if (!childToRestart || childToRestart.exitCode !== null || childToRestart.signalCode !== null) {
      startReplacement();
      return true;
    }

    const forceKillTimeout = setTimeout(() => {
      if (childToRestart.exitCode === null && childToRestart.signalCode === null) {
        childToRestart.kill("SIGKILL");
      }
    }, RESTART_FORCE_KILL_TIMEOUT_MS);
    forceKillTimeout.unref?.();

    childToRestart.once("exit", () => {
      clearTimeout(forceKillTimeout);
      startReplacement();
    });

    if (!childToRestart.kill("SIGTERM")) {
      clearTimeout(forceKillTimeout);
      startReplacement();
    }

    return true;
  }

  function handleTcpRequest(socket, rawRequest) {
    const request = parseTcpRequest(rawRequest);
    if (request === null) {
      return;
    }

    if (request.type === "read") {
      writeHistory(socket, request.amount);
      return;
    }

    if (request.type === "restart") {
      const didStartRestart = restartChildProcess();
      const message = didStartRestart ? "Restarting command" : "Restart already in progress";
      writeSocketText(socket, `[run_bash] ${message}\n`);
    }
  }

  function createTcpServer() {
    return net.createServer((socket) => {
      tcpClients.add(socket);
      socket.setEncoding("utf8");

      let requestBuffer = "";

      socket.on("data", (chunk) => {
        requestBuffer += chunk;

        let newlineIndex = requestBuffer.indexOf("\n");
        while (newlineIndex >= 0) {
          const rawRequest = requestBuffer.slice(0, newlineIndex);
          requestBuffer = requestBuffer.slice(newlineIndex + 1);

          try {
            handleTcpRequest(socket, rawRequest);
          } catch (error) {
            writeSocketText(socket, `[run_bash] ${error.message}\n`);
          }

          newlineIndex = requestBuffer.indexOf("\n");
        }
      });

      socket.on("end", () => {
        if (requestBuffer.trim()) {
          try {
            handleTcpRequest(socket, requestBuffer);
          } catch (error) {
            writeSocketText(socket, `[run_bash] ${error.message}\n`);
          }
        }
      });

      socket.on("close", () => {
        tcpClients.delete(socket);
      });

      socket.on("error", () => {
        tcpClients.delete(socket);
      });
    });
  }

  function handleServerError(error) {
    const address = server?.address();
    const boundAddress = address && typeof address === "object" ? address : null;
    const host = boundAddress?.address ?? configuredHost;
    const port = boundAddress?.port ?? activePort;

    console.error(`[run_bash] TCP server error on ${host}:${port}: ${error.message}`);
    killCurrentChild("SIGTERM");
    closeServerAndClients();
    process.exit(1);
  }

  function listenTcpServer(startPort) {
    return new Promise((resolve, reject) => {
      function attemptListen(port) {
        if (isServerStartupCancelled) {
          reject(createServerStartupCancelledError());
          return;
        }

        if (port > 65535) {
          reject(new Error(`No available TCP port found on ${configuredHost} starting at ${startPort}`));
          return;
        }

        const candidate = createTcpServer();

        const handleInitialError = (error) => {
          if (error?.code === "EADDRINUSE") {
            console.error(`[run_bash] TCP port ${port} on ${configuredHost} is already in use, trying ${port + 1}`);
            attemptListen(port + 1);
            return;
          }

          reject(error);
        };

        candidate.once("error", handleInitialError);
        candidate.listen(port, configuredHost, () => {
          candidate.off("error", handleInitialError);

          if (isServerStartupCancelled) {
            candidate.close(() => {
              reject(createServerStartupCancelledError());
            });
            return;
          }

          resolve(candidate);
        });
      }

      attemptListen(startPort);
    });
  }

  listenTcpServer(configuredPort)
    .then((listeningServer) => {
      server = listeningServer;
      server.on("error", handleServerError);

      const address = server.address();
      if (address && typeof address === "object") {
        activePort = address.port;
        writeCurrentPortFile(activePort);
        const configuredLabel =
          address.port === configuredPort ? "" : ` (configured ${configuredHost}:${configuredPort})`;
        console.error(`[run_bash] TCP listening on ${address.address}:${address.port}${configuredLabel}`);
      }
    })
    .catch((error) => {
      if (error?.code === SERVER_STARTUP_CANCELLED) {
        return;
      }

      console.error(`[run_bash] ${error.message}`);
      killCurrentChild("SIGTERM");
      closeServerAndClients();
      process.exit(1);
    });

  function forwardSignal(signal) {
    if (!child && childPendingRestart) {
      closeServerAndClients();
    }

    killCurrentChild(signal);
  }

  process.on("SIGINT", () => {
    forwardSignal("SIGINT");
  });

  process.on("SIGTERM", () => {
    forwardSignal("SIGTERM");
  });

  startChildProcess();
}

main();
