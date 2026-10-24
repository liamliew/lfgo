// First install: open the options page so the user can paste their API key
// right away instead of hunting for the settings.
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") chrome.runtime.openOptionsPage();
});
