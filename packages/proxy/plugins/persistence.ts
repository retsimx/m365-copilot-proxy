import { loadProxyState, saveProxyState } from "@m365-copilot/proxy-lib";

export default defineNitroPlugin((nitroApp: any) => {
  try {
    loadProxyState();
  } catch {
    // Ignore state loading failure on fresh start
  }

  if (nitroApp?.hooks?.hook) {
    nitroApp.hooks.hook("close", () => {
      try {
        saveProxyState();
      } catch {
        // Ignore save error on shutdown
      }
    });
  }
});
