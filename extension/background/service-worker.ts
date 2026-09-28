/**
 * Background service worker. Its only job is the context-menu entry.
 * It receives the text the user explicitly selected (never page contents),
 * hands it to the BibCleaner page through session storage (memory only),
 * and opens that page in a tab. No "tabs", "scripting" or host access to
 * web pages is needed for this.
 */
const MENU_ID = 'bibcleaner-selection';
const MAX_SELECTION_CHARS = 5_000_000;

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: MENU_ID, title: 'Clean or verify BibTeX', contexts: ['selection'] });
  });
});

chrome.contextMenus.onClicked.addListener(async (info) => {
  if (info.menuItemId !== MENU_ID || !info.selectionText) return;
  const text = info.selectionText.slice(0, MAX_SELECTION_CHARS);
  await chrome.storage.session.set({ pendingSelection: { text, at: Date.now() } });
  await chrome.tabs.create({ url: chrome.runtime.getURL('popup/index.html?view=tab&source=selection') });
});
