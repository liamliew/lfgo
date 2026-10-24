// Safari build only (see scripts/build-safari.mjs). Runs on <short domain>/auth/done, where
// the tab-based Google sign-in ends, and hands the page's address (which carries the
// one-time sign-in code) to the extension. auth.js checks the sender tab and the address.
// Sent twice in case the first lands before the extension has noted which tab it opened;
// the second is ignored once the sign-in has finished.
const report = () => chrome.runtime.sendMessage({ type: "lfc-auth-result", url: location.href }).catch?.(() => {});
report();
setTimeout(report, 1500);
