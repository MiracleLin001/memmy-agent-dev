import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const electronPath = require("electron");

// Some managed Windows sessions cannot start Chromium's renderer sandbox or
// hardware GPU process. Opt into the compatibility switches explicitly with
// MEMMY_DEV_ELECTRON_SAFE_MODE=1; normal development keeps Electron's native
// GPU path so SwiftShader does not consume a full CPU core. These switches are
// limited to the local dev launcher; packaged builds keep Electron's normal
// security and graphics settings.
const windowsDevSafeMode =
  process.platform === "win32" && process.env.MEMMY_DEV_ELECTRON_SAFE_MODE === "1";
const electronArgs = windowsDevSafeMode
  ? [
      "--no-sandbox",
      "--use-angle=swiftshader",
      "--use-gl=angle",
      "--disable-gpu-sandbox",
      "--disable-features=Vulkan",
    ]
  : [];
electronArgs.push("dist/main/main.js");

const child = spawn(electronPath, electronArgs, {
  env: process.env,
  stdio: "inherit",
  windowsHide: false,
});

child.on("error", (error) => {
  console.error("[dev-electron] failed to start Electron:", error);
  process.exitCode = 1;
});

child.on("exit", (code, signal) => {
  if (signal) {
    console.error(`[dev-electron] Electron exited from signal ${signal}`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = code ?? 1;
});
