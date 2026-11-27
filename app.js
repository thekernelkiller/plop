import { previewDocument, downloadBlob } from "./documents.js";
import { formatMarkdown, renderMarkdown } from "./markdown.js";
import {
  signInAnonymously,
  onAuthStateChanged,
  signInWithPopup,
  signInWithCredential,
  GoogleAuthProvider,
  linkWithPopup,
  signOut
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";

import {
  doc, collection, query, where,
  getDoc, setDoc, updateDoc, deleteDoc,
  onSnapshot, writeBatch, serverTimestamp, deleteField, arrayUnion, arrayRemove, runTransaction
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

import { auth, db } from "./firebase-config.js";

// ─────────────────────────────────────────────────────────────────────
// THEME SYSTEM
// ─────────────────────────────────────────────────────────────────────

// Appearance is a local preference shared across spaces.
const appearanceForm = document.getElementById("appearance-form");
const appearanceDialog = document.getElementById("appearance-dialog");
const appearanceDefaults = { page: "paper", title: "display", body: "sans", size: "regular" };
const appearanceKey = "plop.appearance";

function applyAppearance(preferences) {
  const applied = { ...appearanceDefaults };
  for (const key of Object.keys(applied)) {
    const control = appearanceForm.elements.namedItem(key);
    const value = preferences?.[key];
    if ([...control.options].some((option) => option.value === value)) applied[key] = value;
    control.value = applied[key];
    document.documentElement.dataset[key + "Style"] = applied[key];
  }
  return applied;
}

function saveAppearance(preferences) {
  const applied = applyAppearance(preferences);
  try { localStorage.setItem(appearanceKey, JSON.stringify(applied)); } catch {}
}

try {
  applyAppearance(JSON.parse(localStorage.getItem(appearanceKey)));
} catch {
  applyAppearance(appearanceDefaults);
}

document.getElementById("appearance-btn").addEventListener("click", () => appearanceDialog.showModal());
appearanceForm.addEventListener("change", () => saveAppearance(Object.fromEntries(new FormData(appearanceForm))));
appearanceForm.addEventListener("reset", (event) => {
  event.preventDefault();
  saveAppearance(appearanceDefaults);
});
appearanceForm.addEventListener("submit", (event) => event.preventDefault());

function renderIcon(name) {
  return `<svg class="plop-icon" aria-hidden="true"><use href="#icon-${name}"/></svg>`;
}

const SPACE_THEMES = new Set(["charcoal", "teal", "blue", "purple", "amber", "pink", "red", "orange"]);

function spaceTheme(name) {
  return SPACE_THEMES.has(name) ? name : "purple";
}

function applyTheme(name) {
  document.documentElement.dataset.spaceTheme = spaceTheme(name);
}

// ─────────────────────────────────────────────────────────────────────
// GLOBAL STATE
// ─────────────────────────────────────────────────────────────────────

let currentUser        = null;
let activeWorkspaceId  = null;
let activeWorkspace    = null;   // live snapshot of workspace doc
let workspaceItems     = Object.create(null);     // { [id]: itemData }
let unsubItems         = null;
let selectedItemId     = null;
let contextMenuTargetId = null;
let linkDialogParentId = "root";
let folderDialogParentId = "root";
let selectedThemeColor = "purple";
let selectedSpaceIcon = "preset-box";
let spaceIconChanged = false;
const spaceIconPicker = document.getElementById("space-icon-picker");
const presetSpaceIcons = new Set([...spaceIconPicker.querySelectorAll("[data-icon]")].map(button => button.dataset.icon));

function spaceIconKey(space) {
  return `plop.space-icon:${currentUser?.uid}:${space.id}`;
}

function effectiveSpaceIcon(space) {
  try {
    const local = localStorage.getItem(spaceIconKey(space));
    if (presetSpaceIcons.has(local)) return local;
  } catch {}
  return space.icon;
}

function showSpaceIcon(element, space, fallback) {
  const icon = effectiveSpaceIcon(space);
  if (presetSpaceIcons.has(icon)) element.innerHTML = renderIcon(icon);
  else element.replaceChildren(icon || fallback);
}

function saveLocalSpaceIcon(space, icon) {
  try {
    if (icon) localStorage.setItem(spaceIconKey(space), icon);
    else localStorage.removeItem(spaceIconKey(space));
    return true;
  } catch {
    return false;
  }
}
let spaces = [];
let unsubscribeSpaces;
let creatingSpace = false;
const appContainer = document.querySelector(".app-container");
const spaceSwitcher = document.getElementById("space-switcher");
const spaceList = document.getElementById("space-list");
const addToSpace = document.getElementById("space-add-item");
const workspaceIcon = document.getElementById("workspace-icon-display");
const defaultWorkspaceIcon = workspaceIcon.firstElementChild;
const sidebarToggle = document.getElementById("sidebar-toggle");
const phoneLayout = matchMedia("(max-width: 768px)");

function syncSidebarToggle() {
  const visible = phoneLayout.matches
    ? (appContainer.classList.contains("preview-active")
      ? appContainer.classList.contains("mobile-list-open")
      : !appContainer.classList.contains("mobile-canvas-open"))
    : !appContainer.classList.contains("sidebar-hidden");
  sidebarToggle.setAttribute("aria-expanded", String(visible));
}

function toggleSidebar() {
  if (phoneLayout.matches) {
    const mode = appContainer.classList.contains("preview-active") ? "mobile-list-open" : "mobile-canvas-open";
    appContainer.classList.toggle(mode);
  } else {
    appContainer.classList.toggle("sidebar-hidden");
  }
  syncSidebarToggle();
}

phoneLayout.addEventListener("change", syncSidebarToggle);
sidebarToggle.addEventListener("click", toggleSidebar);
document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s" &&
      !event.altKey && !event.shiftKey && !document.querySelector("dialog[open]")) {
    event.preventDefault();
    if (!event.repeat) toggleSidebar();
  }
});

// Shared-folder view
let isSharedView        = false;
let sharedRootFolderId  = null;
let sharedFolderData    = null;  // data from /sharedFolders/{id}

// Drag & drop
let draggedItemId    = null;
let currentDropTarget = null; // { id, zone: 'before'|'after'|'inside' }

// Collapsed folder state — persisted across re-renders & localStorage
const collapsedFolderIds = new Set();

function saveCollapsedState() {
  if (!activeWorkspaceId) return;
  try {
    localStorage.setItem(`lf_collapsed_${activeWorkspaceId}`, JSON.stringify([...collapsedFolderIds]));
  } catch {}
}

function loadCollapsedState(wsId) {
  collapsedFolderIds.clear();
  try {
    const raw = localStorage.getItem(`lf_collapsed_${wsId}`);
    if (raw) {
      JSON.parse(raw).forEach(id => collapsedFolderIds.add(id));
    }
  } catch {}
}

// ─────────────────────────────────────────────────────────────────────
// DOM REFERENCES
// ─────────────────────────────────────────────────────────────────────

const treeRoot             = document.getElementById("tree-root");
const treeScrollContainer  = document.getElementById("tree-scroll-container");
const emptyState           = document.getElementById("empty-state");
const previewState         = document.getElementById("preview-state");
const activeTitle          = document.getElementById("active-title");
const activeUrl            = document.getElementById("active-url");
const activeLinkOpen       = document.getElementById("active-link-open");
const activeLinkOpenWarn   = document.getElementById("active-link-open-warning");
const previewIframe        = document.getElementById("preview-iframe");
const previewToggleViewer  = document.getElementById("preview-toggle-viewer");
const iframeBlockedWarn    = document.getElementById("iframe-blocked-warning");
const dropIndicator        = document.getElementById("drop-indicator");

// Dialogs
const linkDialog         = document.getElementById("link-dialog");
const folderDialog       = document.getElementById("folder-dialog");
const workspaceDialog    = document.getElementById("workspace-dialog");
const folderShareDialog  = document.getElementById("folder-share-dialog");
const accountDialog      = document.getElementById("account-dialog");
const editItemDialog     = document.getElementById("edit-item-dialog");
const deleteConfirmDialog= document.getElementById("delete-confirm-dialog");
const signoutConfirmDialog = document.getElementById("signout-confirm-dialog");

// Context menus
const itemContextMenu  = document.getElementById("item-context-menu");
const spaceContextMenu = document.getElementById("space-context-menu");

// Note elements & Browser Bar elements
const sleekUrlBar          = document.getElementById("sleek-url-bar");
const urlBarCopyBtn        = document.getElementById("url-bar-copy-btn");
const noteInlineTitleInput = document.getElementById("note-inline-title-input");
const noteEditorWrapper    = document.getElementById("note-editor-wrapper");
const documentFileInput = document.getElementById("document-file-input");
const localFileViewer = document.getElementById("local-file-viewer");
const localFileContent = document.getElementById("local-file-content");
const localFileDownload = document.getElementById("local-file-download");
const localFileRemove = document.getElementById("local-file-remove");
let cloudDocuments = new Map();
let unsubDocuments;
let documentPreview;
const notePreviewContainer = document.getElementById("note-preview-container");
const noteRenderedContent  = document.getElementById("note-rendered-content");
const noteInlineEditor     = document.getElementById("note-inline-editor");
const activeNoteEditBtn    = document.getElementById("active-note-edit-btn");
const activeNoteShareBtn   = document.getElementById("active-note-share-btn");
const activeNoteSaveBtn    = document.getElementById("active-note-save-btn");
const activeNoteDiscardBtn = document.getElementById("active-note-discard-btn");
const noteShareDialog      = document.getElementById("note-share-dialog");

let noteDialogParentId = "root";
let editingNoteId      = null;

// ─────────────────────────────────────────────────────────────────────
// AUTH + INITIAL LOAD
// ─────────────────────────────────────────────────────────────────────

onAuthStateChanged(auth, async (user) => {
  if (user) {
    currentUser = user;
    updateAccountUI();

    const urlParams = new URLSearchParams(window.location.search);
    const sharedId = urlParams.get("f") || urlParams.get("note");

    if (sharedId) {
      await loadSharedFolderView(sharedId);
    } else {
      await loadUserWorkspace();
    }
  } else {
    if (currentUser) {
      currentUser = null;
      unsubscribeSpaces?.();
      unsubItems?.();
      unsubDocuments?.();
      spaces = [];
      activeWorkspaceId = null;
      activeWorkspace = null;
      workspaceItems = Object.create(null);
      selectedItemId = null;
      currentPreviewItem = null;
      previewIframe.src = "about:blank";
      treeRoot.textContent = "Loading your spaces…";
      spaceSwitcher.classList.add("hidden");
  spaceOrderButton.classList.add("hidden");
      addToSpace.classList.add("hidden");
      document.getElementById("rename-workspace-btn").classList.add("hidden");
      showEmptyState("Welcome to Plop", "Choose a note or link, or add something to your space.");
    }
    try {
      await signInAnonymously(auth);
    } catch (err) {
      const message = document.createElement("p");
      message.className = "sidebar-status";
      message.setAttribute("role", "alert");
      message.textContent = `Could not sign in. ${err.message}`;
      treeRoot.replaceChildren(message);
    }
  }
});

// ─────────────────────────────────────────────────────────────────────
// WORKSPACE LOADING — OWNER
// ─────────────────────────────────────────────────────────────────────

function loadUserWorkspace() {
  unsubscribeSpaces?.();
  const user = currentUser;
  const ownedSpaces = query(collection(db, "workspaces"), where("ownerId", "==", user.uid));
  let creatingDefault = false;
  unsubscribeSpaces = onSnapshot(ownedSpaces, { includeMetadataChanges: true }, async (snapshot) => {
    if (currentUser !== user || isSharedView) return;
    if (snapshot.empty) {
      if (snapshot.metadata.fromCache) {
        treeRoot.textContent = "Connecting… No spaces are cached on this device.";
        return;
      }
      if (creatingDefault) return;
      creatingDefault = true;
      try {
        await createWorkspace("Bookmarks", user.displayName || "guest", "purple", "");
      } catch (error) {
        if (currentUser === user) treeRoot.textContent = "Could not create a space. Reload to retry.";
        console.error("Could not create a space:", error);
      } finally {
        creatingDefault = false;
      }
      return;
    }

    readSpaces(snapshot);
    const space = spaces.find((entry) => entry.id === activeWorkspaceId);
    if (!space) {
      let lastId;
      try { lastId = localStorage.getItem(`lf_active_ws_${user.uid}`); } catch {}
      loadWorkspace(spaces.find((entry) => entry.id === lastId)?.id || spaces[0].id);
      return;
    }
    const previous = activeWorkspace;
    activeWorkspace = space;
    if (previous?.title !== space.title || previous.icon !== space.icon || previous.themeColor !== space.themeColor) {
      showWorkspaceIdentity(space);
    }
    const previousChildren = previous?.childrenIds || [];
    const nextChildren = space.childrenIds || [];
    if (previousChildren.length !== nextChildren.length ||
        previousChildren.some((id, position) => id !== nextChildren[position])) renderTree(true);
  }, (error) => {
    treeRoot.textContent = "Could not load your spaces. Reload to try again.";
    console.error("Could not sync spaces:", error);
  });
}

async function createWorkspace(title, authorName, themeColor, icon) {
  const id = generateUUID();
  const space = { id, ownerId: currentUser.uid, title, authorName, themeColor, childrenIds: [],
    ...(icon ? { icon } : {}) };
  await setDoc(doc(db, "workspaces", id), { ...space, createdAt: serverTimestamp() });
  return space;
}

const spaceOrderButton = document.getElementById("space-order-btn");
const spaceOrderDialog = document.getElementById("space-order-dialog");
const spaceOrderList = document.getElementById("space-order-list");

function spaceOrderKey() {
  return `plop.space-order:${currentUser.uid}`;
}

function applySpaceOrder() {
  try {
    const saved = JSON.parse(localStorage.getItem(spaceOrderKey()));
    if (!Array.isArray(saved)) return;
    const positions = new Map(saved.map((id, index) => [id, index]));
    spaces.sort((a, b) => (positions.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (positions.get(b.id) ?? Number.MAX_SAFE_INTEGER));
  } catch {}
}

function renderSpaceOrder(focusId, focusDirection) {
  spaceOrderList.replaceChildren();
  spaces.forEach((space, index) => {
    const row = document.createElement("li");
    const name = document.createElement("span");
    name.textContent = space.title;
    row.append(name);
    for (const [direction, label, icon] of [[-1, "up", "left"], [1, "down", "right"]]) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "icon-btn";
      button.innerHTML = renderIcon(icon);
      button.setAttribute("aria-label", `Move ${space.title} ${label}`);
      button.disabled = !spaces[index + direction];
      button.addEventListener("click", () => {
        [spaces[index], spaces[index + direction]] = [spaces[index + direction], spaces[index]];
        try {
          localStorage.setItem(spaceOrderKey(), JSON.stringify(spaces.map((entry) => entry.id)));
        } catch {
          showToast("This browser could not remember your space order.", "error");
        }
        renderSpaces();
        renderSpaceOrder(space.id, direction);
      });
      row.append(button);
      if (space.id === focusId && !button.disabled && (direction === focusDirection ||
          !spaces[index + focusDirection])) queueMicrotask(() => button.focus());
    }
    spaceOrderList.append(row);
  });
}

spaceOrderButton.addEventListener("click", () => {
  renderSpaceOrder();
  spaceOrderDialog.showModal();
});

function readSpaces(snapshot) {
  const previous = spaces;
  spaces = snapshot.docs.map((entry) => ({ ...entry.data(), id: entry.id }))
    .sort((a, b) => (a.createdAt?.seconds ?? Infinity) - (b.createdAt?.seconds ?? Infinity) ||
      a.id.localeCompare(b.id));
  applySpaceOrder();
  if (spaceOrderDialog.open) renderSpaceOrder();
  if (previous.length !== spaces.length || spaces.some((space, index) => {
    const old = previous[index];
    return space.id !== old.id || space.title !== old.title || space.icon !== old.icon || space.themeColor !== old.themeColor;
  })) renderSpaces();
}

function renderSpaces() {
  spaceOrderButton.classList.toggle("hidden", spaces.length < 2 || isSharedView);
  const index = spaces.findIndex((space) => space.id === activeWorkspaceId);
  const hadFocus = spaceList.contains(document.activeElement);
  spaceList.replaceChildren();
  for (const space of spaces) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "space-chip";
    button.dataset.spaceTheme = spaceTheme(space.themeColor);
    const icon = document.createElement("span");
    icon.className = "space-chip-icon";
    icon.setAttribute("aria-hidden", "true");
    showSpaceIcon(icon, space, Array.from(space.title?.trim() || "◇")[0].toLocaleUpperCase());
    const title = document.createElement("span");
    title.className = "space-chip-name";
    title.textContent = space.title;
    button.append(icon, title);
    button.title = space.title;
    if (space.id === activeWorkspaceId) button.setAttribute("aria-current", "true");
    button.addEventListener("click", () => switchSpace(space.id));
    spaceList.append(button);
  }
  const activeChip = spaceList.children[index];
  if (hadFocus) activeChip?.focus({ preventScroll: true });
  activeChip?.scrollIntoView({ block: "nearest", inline: "nearest" });
  document.getElementById("previous-space").disabled = index <= 0;
  document.getElementById("next-space").disabled = index < 0 || index >= spaces.length - 1;
}

function switchSpace(id) {
  if (!id || id === activeWorkspaceId || !canLeaveNote()) return;
  const from = spaces.findIndex((space) => space.id === activeWorkspaceId);
  const to = spaces.findIndex((space) => space.id === id);
  loadWorkspace(id);
  if (!matchMedia("(prefers-reduced-motion: reduce)").matches) {
    const offset = to > from ? 14 : -14;
    for (const surface of [treeRoot, document.getElementById("empty-state")]) {
      surface.getAnimations().forEach((animation) => animation.cancel());
      surface.animate([{ opacity: 0.5, transform: `translateX(${offset}px)` },
        { opacity: 1, transform: "translateX(0)" }], { duration: 240, easing: "ease-out" });
    }
  }
}

function stepSpace(direction) {
  const index = spaces.findIndex((space) => space.id === activeWorkspaceId);
  if (index >= 0) switchSpace(spaces[index + direction]?.id);
}

document.getElementById("previous-space").addEventListener("click", () => stepSpace(-1));
document.getElementById("next-space").addEventListener("click", () => stepSpace(1));
spaceSwitcher.addEventListener("keydown", (event) => {
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
  event.preventDefault();
  stepSpace(event.key === "ArrowLeft" ? -1 : 1);
});

let spaceTouch;
const sidebar = document.querySelector(".sidebar");
sidebar.addEventListener("touchstart", (event) => {
  const touch = event.touches[0];
  spaceTouch = event.touches.length === 1 && !event.target.closest(".space-list")
    ? { x: touch.clientX, y: touch.clientY } : null;
}, { passive: true });
sidebar.addEventListener("touchcancel", () => { spaceTouch = null; });
sidebar.addEventListener("touchend", (event) => {
  if (!spaceTouch || isSharedView) return;
  const touch = event.changedTouches[0];
  const dx = touch.clientX - spaceTouch.x;
  const dy = touch.clientY - spaceTouch.y;
  spaceTouch = null;
  if (Math.abs(dx) > 55 && Math.abs(dx) > Math.abs(dy) * 1.5) stepSpace(dx < 0 ? 1 : -1);
}, { passive: true });

let horizontalTravel = 0;
let previousWheelTime = 0;
let switchedDuringGesture = false;
sidebar.addEventListener("wheel", (event) => {
  if (isSharedView || event.ctrlKey || event.target.closest(".space-list") ||
      event.deltaMode !== WheelEvent.DOM_DELTA_PIXEL || Math.abs(event.deltaX) <= Math.abs(event.deltaY)) return;
  if (event.timeStamp - previousWheelTime > 160) {
    horizontalTravel = 0;
    switchedDuringGesture = false;
  }
  previousWheelTime = event.timeStamp;
  horizontalTravel += event.deltaX;
  if (!switchedDuringGesture && Math.abs(horizontalTravel) > 72) {
    switchedDuringGesture = true;
    stepSpace(horizontalTravel > 0 ? 1 : -1);
  }
}, { passive: true });

function loadWorkspace(wsId) {
  unsubItems?.();
  unsubDocuments?.();

  isSharedView = false;
  sharedRootFolderId = null;
  sharedFolderData = null;
  activeWorkspaceId = wsId;
  cloudDocuments = new Map();
  const owner = currentUser.uid;
  unsubDocuments = onSnapshot(collection(db, "workspaces", wsId, "documents"), (snapshot) => {
    if (activeWorkspaceId !== wsId || currentUser?.uid !== owner || isSharedView) return;
    cloudDocuments = new Map(snapshot.docs.map((entry) => [entry.id, {
      ...entry.data(), id: entry.id, space: wsId, owner, type: "document"
    }]));
    if (currentPreviewItem?.type === "document" &&
        !cloudDocuments.has(currentPreviewItem.id)) {
      currentPreviewItem = null;
      selectedItemId = null;
      showEmptyState(activeWorkspace?.title || "Plop", "This file is no longer in the space.");
    }
    renderTree(true);
  }, (error) => console.warn("Cloud documents unavailable:", error));
  activeWorkspace = spaces.find((entry) => entry.id === wsId);
  workspaceItems = Object.create(null);
  selectedItemId = null;
  currentPreviewItem = null;
  previewIframe.src = "about:blank";
  const space = activeWorkspace;
  if (space) showWorkspaceIdentity(space);
  showEmptyState(space?.title || "Plop", "Choose a note or link, or add something to this space.");
  treeRoot.textContent = "";
  spaceSwitcher.classList.remove("hidden");
  addToSpace.classList.toggle("hidden", !space);
  renderSpaces();
  recoverDocumentUploads(owner, wsId);

  try { localStorage.setItem(`lf_active_ws_${currentUser.uid}`, wsId); } catch {}
  loadCollapsedState(wsId);

  // Live items subcollection
  const drafts = draftsForWorkspace(wsId);
  unsubItems = onSnapshot(collection(db, "workspaces", wsId, "items"), { includeMetadataChanges: true }, (snap) => {
    if (activeWorkspaceId !== wsId || isSharedView) return;
    workspaceItems = Object.create(null);
    const pending = new Set();
    snap.forEach((entry) => {
      workspaceItems[entry.id] = entry.data();
      if (entry.metadata?.hasPendingWrites) pending.add(entry.id);
    });
    for (const [id, key] of drafts) {
      if (pendingNoteEdits.has(key) || pending.has(id)) continue;
      const item = workspaceItems[id];
      const value = readNoteDraft(key);
      if (!item && snap.metadata.fromCache) continue;
      drafts.delete(id);
      if (!value) continue;
      if (!item) {
        const recoveryKey = value.recoveryKey;
        if (typeof recoveryKey === "string" && recoveryKey.startsWith(noteDraftKey(wsId, "new:")) && !readNoteDraft(recoveryKey)) {
          try {
            localStorage.setItem(recoveryKey, JSON.stringify({ title: value.title, content: value.content }));
            localStorage.removeItem(key);
          } catch {}
        }
      } else if (sameNote(item, value)) {
        clearNoteDraft({ key }, value);
      } else {
        scheduleNoteSync({
          key, id, uid: currentUser.uid, workspaceId: wsId, base: item, value, local: true
        });
      }
    }
    renderTree(true);
  });

  document.getElementById("rename-workspace-btn").classList.remove("hidden");
}

function showWorkspaceIdentity(space) {
  applyTheme(space.themeColor || "purple");
  document.getElementById("workspace-title-display").textContent = space.title;
  showSpaceIcon(workspaceIcon, space, defaultWorkspaceIcon);
}

addToSpace.addEventListener("click", () => {
  const bounds = addToSpace.getBoundingClientRect();
  showSpaceContextMenu(bounds.left, bounds.bottom + 4);
});

// ─────────────────────────────────────────────────────────────────────
// SHARED FOLDER VIEW — VISITOR
// ─────────────────────────────────────────────────────────────────────

async function loadSharedFolderView(folderId) {
  unsubDocuments?.();
  if (unsubItems)     unsubItems();

  unsubscribeSpaces?.();
  spaceSwitcher.classList.add("hidden");
  spaceOrderButton.classList.add("hidden");
  addToSpace.classList.add("hidden");
  isSharedView       = true;
  sharedRootFolderId = folderId;
  workspaceItems     = Object.create(null);

  treeRoot.innerHTML = `<div class="loading-spinner"><div class="spinner"></div><span>Loading shared folder…</span></div>`;

  const shareSnap = /^[\da-f-]{36}$/i.test(folderId)
    ? await getDoc(doc(db, "sharedFolders", folderId)).catch(() => null) : null;
  if (!shareSnap?.exists()) {
    treeRoot.innerHTML = `<div class="loading-spinner"><span>This share link is no longer active.</span></div>`;
    return;
  }

  sharedFolderData  = shareSnap.data();
  const workspaceId = sharedFolderData.workspaceId;
  activeWorkspaceId = workspaceId;

  showWorkspaceIdentity({ ...sharedFolderData, title: sharedFolderData.folderTitle });

  // Hide owner-only controls
  document.getElementById("add-folder-btn")?.classList.add("hidden");
  document.getElementById("rename-workspace-btn").classList.add("hidden");

  // Subscribe to items that have sharedVia == folderId
  unsubItems = onSnapshot(
    query(collection(db, "workspaces", workspaceId, "items"),
          where("sharedVia", "==", folderId)),
    (snap) => {
      workspaceItems = Object.create(null);
      snap.forEach(d => { workspaceItems[d.id] = d.data(); });
      renderTree(false);
    }, () => {
      workspaceItems = Object.create(null);
      currentPreviewItem = null;
      treeRoot.textContent = "This share is unavailable.";
      showEmptyState("Share unavailable", "The link may have been turned off, or you may be offline.");
    }
  );

  // Show clone banner
  renderCloneBanner();
}

function renderCloneBanner() {
  let banner = document.getElementById("clone-banner");
  if (!banner) {
    banner = document.createElement("div");
    banner.id = "clone-banner";
    banner.className = "clone-banner-overlay";
    banner.innerHTML = `
      <button id="clone-btn" class="footer-btn clone-btn">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
        </svg>
        <span>Copy folder to my spaces</span>
      </button>`;
    document.querySelector(".sidebar-footer").prepend(banner);
    document.getElementById("clone-btn").addEventListener("click", cloneSharedFolder);
  }
}

async function cloneSharedFolder() {
  if (!currentUser) return;

  const cloneBtn = document.getElementById("clone-btn");
  cloneBtn.textContent = "Cloning…";
  cloneBtn.disabled = true;

  try {
    const newWsId = generateUUID();
    const idMap = Object.create(null);

    // Ensure the user has a workspace; if not, this becomes it
    await setDoc(doc(db, "workspaces", newWsId), {
      id: newWsId,
      ownerId:    currentUser.uid,
      title:      `${sharedFolderData.folderTitle.slice(0, 42)} (clone)`,
      authorName: currentUser.displayName || sharedFolderData.authorName || "guest",
      themeColor: sharedFolderData.themeColor || "purple",
      childrenIds: [],
      createdAt:  serverTimestamp()
    });

    // Remap IDs
    Object.keys(workspaceItems).forEach(oldId => { idMap[oldId] = generateUUID(); });


    const batch = writeBatch(db);

    Object.values(workspaceItems).forEach(item => {
      const newId = idMap[item.id];
      const cloned = {
        id:        newId,
        parentId:  item.parentId === sharedRootFolderId ? "root" : (idMap[item.parentId] || item.parentId),
        type:      item.type,
        title:     item.title,
        createdAt: item.createdAt,
        ...(item.url ? { url: item.url } : {}),
        ...(item.type === "note" ? { content: item.content || "" } : {}),
        ...(item.childrenIds? { childrenIds: item.childrenIds.map(cid => idMap[cid] || cid) } : {}),
      };
      batch.set(doc(db, "workspaces", newWsId, "items", newId), cloned);
    });

    // Root folder's children become workspace root children
    const sharedRoot = workspaceItems[sharedRootFolderId];
    const rootChildren = (sharedRoot?.childrenIds || []).map(cid => idMap[cid] || cid);
    await updateDoc(doc(db, "workspaces", newWsId), { childrenIds: rootChildren });

    await batch.commit();

    localStorage.setItem(`lf_active_ws_${currentUser.uid}`, newWsId);
    window.location.search = "";
  } catch (err) {
    console.error("Clone failed:", err);
    cloneBtn.textContent = "Clone failed — try again";
    cloneBtn.disabled = false;
  }
}

// ─────────────────────────────────────────────────────────────────────
// RENDER TREE
// ─────────────────────────────────────────────────────────────────────

function renderTree(isOwner) {
  if (!activeWorkspaceId) return;

  treeRoot.innerHTML = "";

  if (selectedItemId && !workspaceItems[selectedItemId] && !cloudDocuments.has(selectedItemId)) {
    selectedItemId = null;
  }

  if (isSharedView) {
    const rootFolder = workspaceItems[sharedRootFolderId];
    if (!rootFolder) return;

    // If a single note was shared
    if (rootFolder.type === "note") {
      treeRoot.appendChild(renderNode(rootFolder, 0, false));
      selectedItemId = rootFolder.id;
      showPreviewState(rootFolder);
      return;
    }

    (rootFolder.childrenIds || []).forEach(childId => {
      const child = workspaceItems[childId];
      if (child) treeRoot.appendChild(renderNode(child, 0, false));
    });

    if ((rootFolder.childrenIds || []).length === 0) {
      showEmptyState(rootFolder.title, "This shared folder is empty.");
    } else if (selectedItemId && workspaceItems[selectedItemId]) {
      const selectedItem = workspaceItems[selectedItemId];
      if (selectedItem.type === "folder") {
        showEmptyState(selectedItem.title, `Folder · ${(selectedItem.childrenIds || []).length} items`);
      } else {
        showPreviewState(selectedItem);
      }
    }
    return;
  }

  if (!activeWorkspace) return;

  const rootIds = activeWorkspace.childrenIds || [];
  if (rootIds.length === 0 && !cloudDocuments.size) {
    if (!isEditingNote()) showEmptyState(activeWorkspace.title, "Add a note, link, or folder to get started.");
    return;
  }

  rootIds.forEach(itemId => {
    const item = workspaceItems[itemId];
    if (item && item.parentId === "root") {
      treeRoot.appendChild(renderNode(item, 0, true));
    }
  });

  appendCloudDocuments(treeRoot, "root", 0);
  if (isEditingNote() || cloudDocuments.has(selectedItemId)) return;

  if (selectedItemId && workspaceItems[selectedItemId]) {
    const selectedItem = workspaceItems[selectedItemId];
    if (selectedItem.type === "folder") {
      showEmptyState(selectedItem.title, `Folder · ${(selectedItem.childrenIds || []).length} items`);
    } else {
      showPreviewState(selectedItem);
    }
  } else {
    emptyState.classList.remove("hidden");
    previewState.classList.add("hidden");
  }
}

function setLinkIcon(element, address) {
  element.innerHTML = renderIcon("link");
  if (!isValidUrl(address)) return;
  const url = new URL("/favicon.ico", address);
  if (location.protocol === "https:" && url.protocol !== "https:") return;
  const image = document.createElement("img");
  image.alt = "";
  image.width = image.height = 15;
  image.className = "site-favicon";
  image.referrerPolicy = "no-referrer";
  image.addEventListener("load", () => {
    image.classList.add("icon-loaded");
    element.querySelector(".plop-icon")?.classList.add("hidden");
  }, { once: true });
  image.addEventListener("error", () => image.remove(), { once: true });
  element.append(image);
  image.src = url.href;
}

function appendCloudDocuments(container, parent, depth) {
  for (const file of cloudDocuments.values()) {
    const actualParent = workspaceItems[file.parent]?.type === "folder" ? file.parent : "root";
    if (actualParent !== parent) continue;
    const button = document.createElement("button");
    button.type = "button";
    button.className = `tree-item local-file-row${selectedItemId === file.id ? " selected" : ""}`;
    button.style.setProperty("--depth", depth);
    button.title = file.title;
    button.innerHTML = renderIcon("file");
    const title = document.createElement("span");
    title.className = "tree-item-title";
    title.textContent = file.title;
    const tag = document.createElement("span");
    tag.className = "local-file-tag";
    tag.textContent = file.format.toUpperCase();
    button.append(title, tag);
    button.addEventListener("click", () => {
      if (!canLeaveNote()) return;
      selectedItemId = file.id;
      showPreviewState(file);
      renderTree(true);
    });
    container.append(button);
  }
}

function renderNode(item, depth, isOwner, ancestors = new Set()) {
  const isFolder = item.type === "folder";
  // Use persisted collapsed state; default open
  const isExpanded = !collapsedFolderIds.has(item.id);

  const el = document.createElement("div");
  el.className = `tree-item${selectedItemId === item.id ? " selected" : ""}`;
  el.dataset.id   = item.id;
  el.dataset.type = item.type;
  el.draggable    = isOwner;
  el.style.setProperty("--depth", depth);

  // ── Toggle arrow (folders only) ──
  const toggleEl = isFolder ? document.createElement("button") : null;
  if (isFolder) {
    toggleEl.className = `folder-toggle${isExpanded ? "" : " collapsed"}`;
    toggleEl.type = "button";
    toggleEl.setAttribute("aria-label", `Toggle ${item.title}`);
    toggleEl.setAttribute("aria-expanded", String(isExpanded));
    toggleEl.innerHTML = renderIcon("down");
    toggleEl.addEventListener("click", (e) => {
      e.stopPropagation();
      const childCont = el.nextElementSibling;
      const collapsed = toggleEl.classList.toggle("collapsed");
      toggleEl.setAttribute("aria-expanded", String(!collapsed));
      if (childCont?.classList.contains("folder-children")) {
        childCont.style.display = collapsed ? "none" : "";
      }
      // Persist collapsed state so re-renders don't reset it
      if (collapsed) {
        collapsedFolderIds.add(item.id);
      } else {
        collapsedFolderIds.delete(item.id);
      }
      saveCollapsedState();
    });
  }

  // ── Icon ──
  const iconEl = document.createElement("span");
  if (isFolder) {
    iconEl.className = "folder-icon";
    iconEl.innerHTML = renderIcon("folder");
  } else if (item.type === "note") {
    iconEl.className = "note-icon";
    iconEl.innerHTML = renderIcon("note");
  } else {
    iconEl.className = "link-favicon-wrap";
    setLinkIcon(iconEl, item.url);
  }

  // ── Title ──
  const titleEl = document.createElement("span");
  titleEl.className    = "tree-item-title";
  titleEl.textContent  = item.title;

  // ── Content container (aligns toggle, icon, title) ──
  const contentEl = document.createElement("div");
  contentEl.className = "tree-item-content";
  contentEl.appendChild(iconEl);
  contentEl.appendChild(titleEl);
  el.appendChild(contentEl);
  if (toggleEl) el.appendChild(toggleEl);

  // ── Actions (3-dot button) ──
  if (isOwner) {
    const actionsEl = document.createElement("div");
    actionsEl.className = "tree-item-actions";

    const optBtn = document.createElement("button");
    optBtn.className  = "item-btn";
    optBtn.type = "button";
    optBtn.title = "Options";
    optBtn.setAttribute("aria-label", `Options for ${item.title}`);
    optBtn.innerHTML  = `<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>`;
    optBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      showContextMenu(item.id, e.clientX, e.clientY, item.type);
    });
    actionsEl.appendChild(optBtn);
    el.appendChild(actionsEl); // Appended directly to el for space-between flex layout
  }

  // ── Right-click context menu ──
  if (isOwner) {
    el.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      showContextMenu(item.id, e.clientX, e.clientY, item.type);
    });
  }

  // ── Click to select ──
  contentEl.addEventListener("click", (e) => {
    if (e.target.closest(".folder-toggle") || e.target.closest(".item-btn")) return;
    if (isEditingNote() && item.id === editingNoteId) {
      appContainer.classList.remove("mobile-list-open");
      syncSidebarToggle();
      return;
    }
    if (!canLeaveNote()) return;
    appContainer.classList.remove("mobile-list-open");
    if (isFolder) {
      document.querySelectorAll(".tree-item.selected").forEach(el => el.classList.remove("selected"));
      el.classList.add("selected");
      selectedItemId = item.id;
      showEmptyState(item.title, `Folder · ${(item.childrenIds || []).length} items`);
    } else {
      document.querySelectorAll(".tree-item.selected").forEach(el => el.classList.remove("selected"));
      el.classList.add("selected");
      selectedItemId = item.id;
      showPreviewState(item);
    }
  });

  // ── Drag events (owner only) ──
  if (isOwner) {
    el.addEventListener("dragstart", (e) => {
      e.stopPropagation();
      draggedItemId = item.id;
      el.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", item.id);
    });

    el.addEventListener("dragend", () => {
      el.classList.remove("dragging");
      draggedItemId = null;
      clearDropVisuals();
    });
  }

  // ── Children ──
  if (isFolder) {
    const childrenContainer = document.createElement("div");
    childrenContainer.className = "folder-children";
    childrenContainer.style.display = isExpanded ? "" : "none";

    (item.childrenIds || []).forEach(childId => {
      const child = workspaceItems[childId];
      if (child && child.parentId === item.id && !ancestors.has(childId) && childId !== item.id) {
        childrenContainer.appendChild(renderNode(child, depth + 1, isOwner, new Set([...ancestors, item.id])));
      }
    });

    if (isOwner) appendCloudDocuments(childrenContainer, item.id, depth + 1);

    el.after(childrenContainer);
    // Return a wrapper so both el + childrenContainer are injected together
    const wrap = document.createDocumentFragment();
    wrap.appendChild(el);
    wrap.appendChild(childrenContainer);
    return wrap;
  }

  return el;
}

// ─────────────────────────────────────────────────────────────────────
// UI HELPERS & NOTIFICATIONS
// ─────────────────────────────────────────────────────────────────────

function showToast(message, type = "info", duration = 3000) {
  let container = document.querySelector(".toast-container");
  if (!container) {
    container = document.createElement("div");
    container.className = "toast-container";
    document.body.appendChild(container);
  }

  const toast = document.createElement("div");
  toast.className = `toast ${type}`;

  toast.setAttribute("role", type === "error" ? "alert" : "status");
  const icon = document.createElement("span");
  icon.className = "toast-symbol";
  icon.setAttribute("aria-hidden", "true");
  icon.textContent = { success: "✓", error: "!", loading: "…", info: "·" }[type] || "·";
  toast.append(icon, document.createTextNode(message));
  container.appendChild(toast);

  if (type !== "loading" && duration > 0) {
    setTimeout(() => {
      toast.style.opacity = "0";
      toast.style.transform = "translateY(16px)";
      toast.style.transition = "all 0.3s ease";
      setTimeout(() => toast.remove(), 300);
    }, duration);
  }

  return toast;
}

function setButtonLoading(button, isLoading, loadingText = "Saving...") {
  if (!button) return;
  if (isLoading) {
    button.dataset.originalText = button.innerHTML;
    button.disabled = true;
    button.classList.add("btn-loading");
    button.innerHTML = `<span class="btn-spinner"></span><span>${loadingText}</span>`;
  } else {
    button.disabled = false;
    button.classList.remove("btn-loading");
    if (button.dataset.originalText) {
      button.innerHTML = button.dataset.originalText;
      delete button.dataset.originalText;
    }
  }
}

function showEmptyState(title, desc) {
  closeDocumentPreview();
  noteEditorWrapper.classList.add("hidden");
  appContainer.classList.remove("preview-active", "mobile-list-open", "mobile-canvas-open");
  syncSidebarToggle();
  document.getElementById("empty-title").textContent = title;
  document.getElementById("empty-desc").textContent  = desc;
  emptyState.classList.remove("hidden");
  previewState.classList.add("hidden");
}

let currentPreviewItem = null;
let currentPreviewMode = "direct"; // "direct" | "viewer"

function isPdfUrl(url) {
  if (!url) return false;
  const cleanUrl = url.split("?")[0].split("#")[0].toLowerCase();
  return cleanUrl.endsWith(".pdf") || cleanUrl.includes(".pdf");
}

function getViewerUrl(url) {
  return `https://docs.google.com/gview?url=${encodeURIComponent(url)}&embedded=true`;
}

function setPreviewIframeSrc(url, mode) {
  currentPreviewMode = mode;
  const src = !isValidUrl(url) ? "about:blank" : mode === "viewer" ? getViewerUrl(url) : url;
  if (previewIframe.getAttribute("src") !== src) previewIframe.src = src;
}

function closeDocumentPreview() {
  documentPreview?.abort();
  documentPreview = null;
  localFileViewer.classList.add("hidden");
  localFileDownload.classList.add("hidden");
  localFileRemove.classList.add("hidden");
  previewState.classList.remove("viewing-document");
}

const documentTypes = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
};

async function storageReference(file) {
  const sdk = await import("https://www.gstatic.com/firebasejs/10.8.0/firebase-storage.js");
  const storage = sdk.getStorage();
  storage.maxUploadRetryTime = 15000;
  storage.maxOperationRetryTime = 10000;
  return { ...sdk, reference: sdk.ref(storage, `documents/${file.owner}/${file.space}/${file.id}`) };
}

function documentMetadata(file) {
  return doc(db, "workspaces", file.space, "documents", file.id);
}

async function loadDocumentBlob(file) {
  const { getBlob, reference } = await storageReference(file);
  return getBlob(reference, 25 * 1024 * 1024);
}

const activeDocumentUploads = new Set();

function uploadJournalKey(owner, space) {
  return `plop.pending-uploads:${owner}:${space}`;
}

function readUploadJournal(owner, space) {
  try {
    const entries = JSON.parse(localStorage.getItem(uploadJournalKey(owner, space)));
    return Array.isArray(entries) ? entries : [];
  } catch { return []; }
}

function rememberUpload(file, finished = false) {
  const entries = readUploadJournal(file.owner, file.space).filter((entry) => entry.id !== file.id);
  if (!finished) entries.push(file);
  try {
    const key = uploadJournalKey(file.owner, file.space);
    if (entries.length) localStorage.setItem(key, JSON.stringify(entries));
    else localStorage.removeItem(key);
    return true;
  } catch { return false; }
}

async function uploadDeadline(operation, milliseconds, message, cancel) {
  let timer;
  try {
    return await Promise.race([operation, new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(message));
        cancel?.();
      }, milliseconds);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

function publishCloudDocument(file) {
  return uploadDeadline(runTransaction(db, async (transaction) => {
    const reference = documentMetadata(file);
    if ((await transaction.get(reference)).exists()) return;
    transaction.set(reference, { title: file.title, format: file.format, parent: file.parent });
  }), 15000, "Firebase has not confirmed the file listing. Plop will check again when you reopen the space.");
}

async function uploadCloudDocument(file, blob, progress) {
  const remembered = rememberUpload(file);
  activeDocumentUploads.add(file.id);
  try {
    progress("Connecting to Firebase Storage…");
    const { uploadBytesResumable, reference } = await uploadDeadline(storageReference(file), 12000,
      "Could not reach Firebase Storage. Check your connection and try the file again.");
    const upload = uploadBytesResumable(reference, blob, { contentType: documentTypes[file.format] });
    const unsubscribe = upload.on("state_changed", (snapshot) => {
      if (!snapshot.totalBytes) return;
      const percent = Math.min(100, Math.floor(snapshot.bytesTransferred / snapshot.totalBytes * 100));
      progress(`Uploading “${file.title}” · ${percent}%`);
    });
    try {
      await uploadDeadline(upload, 45000, "The upload timed out. Plop will check Firebase when you reopen the space.", () => upload.cancel());
    } finally {
      unsubscribe();
    }
    progress("Upload received. Adding the file to your space…");
    await publishCloudDocument(file);
    rememberUpload(file, true);
  } catch (error) {
    if (["storage/unauthorized", "storage/no-default-bucket", "storage/bucket-not-found"].includes(error.code)) {
      rememberUpload(file, true);
      throw new Error("Firebase Storage rejected the upload. Check the configured bucket and published Storage rules.");
    }
    if (error.code === "permission-denied") {
      throw new Error("Firebase received the file, but Firestore rejected its listing. Publish the Firestore rules and reopen this space.");
    }
    if (!remembered) throw new Error(`${error.message} This browser could not record the upload for recovery.`);
    throw error;
  } finally {
    activeDocumentUploads.delete(file.id);
  }
}

async function recoverDocumentUploads(owner, space) {
  if (!navigator.onLine) return;
  for (const file of readUploadJournal(owner, space)) {
    if (currentUser?.uid !== owner || activeWorkspaceId !== space) return;
    if (file.owner !== owner || file.space !== space || !documentTypes[file.format] ||
        !/^[0-9a-f-]{36}$/.test(file.id) || activeDocumentUploads.has(file.id)) continue;
    activeDocumentUploads.add(file.id);
    try {
      const { getMetadata, reference } = await uploadDeadline(storageReference(file), 12000, "Firebase Storage unavailable.");
      await uploadDeadline(getMetadata(reference), 15000, "Firebase could not confirm the upload.");
      await publishCloudDocument(file);
      rememberUpload(file, true);
      showToast(`Recovered “${file.title}” from Firebase.`, "success");
    } catch (error) {
      if (error.code === "storage/object-not-found") {
        rememberUpload(file, true);
        showToast(`“${file.title}” did not finish uploading. Select the original file again.`, "error", 7000);
      } else {
        showToast(`Firebase could not finish recovering “${file.title}”. Check the connection and Firebase rules, then reopen the space.`, "error", 7000);
      }
    } finally {
      activeDocumentUploads.delete(file.id);
    }
  }
}

window.addEventListener("online", () => {
  if (currentUser && activeWorkspaceId && !isSharedView) recoverDocumentUploads(currentUser.uid, activeWorkspaceId);
});

function warnBeforeUploadExit(event) {
  if (!activeDocumentUploads.size) return;
  event.preventDefault();
  event.returnValue = "";
}

window.addEventListener("beforeunload", warnBeforeUploadExit);

function showCloudFile(file) {
  previewState.classList.add("viewing-document");
  activeTitle.textContent = file.title;
  previewIframe.src = "about:blank";
  for (const element of [previewIframe, notePreviewContainer, sleekUrlBar, noteInlineTitleInput,
    activeLinkOpen, previewToggleViewer, activeNoteEditBtn, activeNoteSaveBtn, activeNoteDiscardBtn,
    activeNoteShareBtn, urlBarCopyBtn]) element.classList.add("hidden");
  localFileViewer.classList.remove("hidden");
  localFileDownload.classList.remove("hidden");
  localFileRemove.classList.remove("hidden");
  localFileRemove.disabled = false;
  localFileContent.textContent = "Opening file…";
  documentPreview = new AbortController();
  const { signal } = documentPreview;
  loadDocumentBlob(file).then((blob) => {
    if (!signal.aborted) return previewDocument({ ...file, blob }, localFileContent, signal);
  }).catch((error) => {
    if (signal.aborted) return;
    console.warn("Could not display cloud file:", error);
    localFileContent.textContent = "Preview unavailable. You can still download the original file.";
  });
}

localFileDownload.addEventListener("click", async () => {
  const file = currentPreviewItem;
  if (file?.type !== "document") return;
  try { downloadBlob(await loadDocumentBlob(file), file.title); }
  catch { showToast("Could not download this file. Check your connection.", "error"); }
});

localFileRemove.addEventListener("click", async () => {
  const file = currentPreviewItem;
  if (file?.type !== "document" || localFileRemove.disabled) return;
  if (!window.confirm(`Delete “${file.title}” from all devices?`)) return;
  localFileRemove.disabled = true;
  try {
    const { deleteObject, reference } = await storageReference(file);
    try { await deleteObject(reference); }
    catch (error) { if (error.code !== "storage/object-not-found") throw error; }
    await deleteDoc(documentMetadata(file));
    if (activeWorkspaceId === file.space && currentUser?.uid === file.owner) cloudDocuments.delete(file.id);
    if (currentPreviewItem?.id === file.id) {
      selectedItemId = null;
      currentPreviewItem = null;
      showEmptyState(activeWorkspace?.title || "Plop", "Choose a note or link, or add something to this space.");
    }
    renderTree(true);
  } catch (error) {
    showToast(error.message || "Could not remove the file.", "error");
  } finally {
    if (currentPreviewItem?.id === file.id) localFileRemove.disabled = false;
  }
});

function showPreviewState(item) {
  closeDocumentPreview();
  urlBarCopyBtn.classList.remove("hidden");
  if (item.type === "note" && !isSharedView) {
    const draft = readNoteDraft(noteDraftKey(activeWorkspaceId, item.id));
    if (draft) item = { ...item, ...draft, title: draft.title.trim() || "Untitled Note.md" };
  }
  previewState.classList.toggle("viewing-note", item.type === "note");
  previewState.classList.remove("editing-note");
  noteEditorWrapper.classList.add("hidden");
  appContainer.classList.add("preview-active");
  appContainer.classList.remove("mobile-canvas-open");
  syncSidebarToggle();
  currentPreviewItem = item;
  const copyLabel = item.type === "link" || item.sharedVia ? "Copy link" : "Copy note";
  urlBarCopyBtn.setAttribute("aria-label", copyLabel);
  urlBarCopyBtn.title = copyLabel;
  emptyState.classList.add("hidden");
  previewState.classList.remove("hidden");
  if (iframeBlockedWarn) iframeBlockedWarn.classList.add("hidden");
  if (item.type === "document") {
    showCloudFile(item);
    return;
  }

  if (item.type === "note") {
    // Show Markdown Note View
    activeTitle.textContent = item.title;
    activeUrl.textContent   = item.title || "Markdown Document";
    
    // Header elements
    sleekUrlBar.classList.remove("hidden");
    noteInlineTitleInput.classList.add("hidden");
    activeLinkOpen.classList.add("hidden");
    if (previewToggleViewer) previewToggleViewer.classList.add("hidden");
    
    // Only show Edit & Share buttons for the workspace owner, not for viewers
    if (activeNoteEditBtn) activeNoteEditBtn.classList.toggle("hidden", isSharedView);
    if (activeNoteShareBtn) activeNoteShareBtn.classList.toggle("hidden", isSharedView);
    if (activeNoteSaveBtn) activeNoteSaveBtn.classList.add("hidden");
    if (activeNoteDiscardBtn) activeNoteDiscardBtn.classList.add("hidden");

    if (previewIframe.getAttribute("src") !== "about:blank") previewIframe.src = "about:blank";
    previewIframe.classList.add("hidden");
    if (notePreviewContainer) {
      notePreviewContainer.classList.remove("hidden");
      noteRenderedContent.classList.remove("hidden");
      if (noteEditorWrapper) noteEditorWrapper.classList.add("hidden");
      renderMarkdown(noteRenderedContent, item.content || "");
    }
  } else {
    // Show Link / WebView
    activeTitle.textContent = item.title || item.url;
    activeUrl.textContent   = item.url;
    const canOpen = isValidUrl(item.url);
    activeLinkOpen.href = canOpen ? item.url : "about:blank";
    activeLinkOpenWarn.href = activeLinkOpen.href;
    
    // Header elements
    sleekUrlBar.classList.remove("hidden");
    noteInlineTitleInput.classList.add("hidden");
    activeLinkOpen.classList.toggle("hidden", !canOpen);
    if (previewToggleViewer) previewToggleViewer.classList.remove("hidden");
    if (activeNoteEditBtn) activeNoteEditBtn.classList.add("hidden");
    if (activeNoteShareBtn) activeNoteShareBtn.classList.add("hidden");
    if (activeNoteSaveBtn) activeNoteSaveBtn.classList.add("hidden");
    if (activeNoteDiscardBtn) activeNoteDiscardBtn.classList.add("hidden");

    if (notePreviewContainer) notePreviewContainer.classList.add("hidden");
    previewIframe.classList.remove("hidden");

    const isPdf = isPdfUrl(item.url);
    if (isPdf) {
      setPreviewIframeSrc(item.url, "viewer");
    } else {
      setPreviewIframeSrc(item.url, "direct");
    }
  }
}

// ── Lightweight In-Viewer Note Creation & Editor ──

function openInlineNoteEditor(noteId = null, parentId = "root") {
  if (isSharedView || !activeWorkspace || !canLeaveNote()) return;
  closeDocumentPreview();
  previewState.classList.add("viewing-note", "editing-note");
  appContainer.classList.add("preview-active");
  appContainer.classList.remove("mobile-list-open", "mobile-canvas-open");
  syncSidebarToggle();

  editingNoteId = noteId;
  noteDialogParentId = (parentId && workspaceItems[parentId]?.type === "folder") ? parentId : "root";

  emptyState.classList.add("hidden");
  previewState.classList.remove("hidden");
  if (iframeBlockedWarn) iframeBlockedWarn.classList.add("hidden");
  if (previewIframe.getAttribute("src") !== "about:blank") previewIframe.src = "about:blank";
  previewIframe.classList.add("hidden");

  // Show note container and editor wrapper
  if (notePreviewContainer) notePreviewContainer.classList.remove("hidden");
  if (noteRenderedContent) noteRenderedContent.classList.add("hidden");
  if (noteEditorWrapper) noteEditorWrapper.classList.remove("hidden");

  // In the header bar
  sleekUrlBar.classList.add("hidden");
  noteInlineTitleInput.classList.remove("hidden");

  // Show Save & Cancel buttons; hide other actions
  if (activeNoteSaveBtn) activeNoteSaveBtn.classList.remove("hidden");
  if (activeNoteDiscardBtn) activeNoteDiscardBtn.classList.remove("hidden");
  if (activeNoteEditBtn) activeNoteEditBtn.classList.add("hidden");
  if (activeNoteShareBtn) activeNoteShareBtn.classList.add("hidden");
  if (previewToggleViewer) previewToggleViewer.classList.add("hidden");
  if (activeLinkOpen) activeLinkOpen.classList.add("hidden");

  if (noteId && workspaceItems[noteId]) {
    const item = workspaceItems[noteId];
    currentPreviewItem = item;
    activeTitle.textContent = item.title;
    noteInlineTitleInput.value = item.title || "";
    noteInlineEditor.value = item.content || "";
    setTimeout(() => noteInlineEditor.focus(), 50);
  } else {
    currentPreviewItem = { id: null, type: "note", title: "", content: "", parentId: noteDialogParentId, isNew: true };
    activeTitle.textContent = "New Note";
    noteInlineTitleInput.value = "";
    noteInlineEditor.value = "";
    setTimeout(() => noteInlineTitleInput.focus(), 50);
  }
  const key = noteDraftKey(activeWorkspaceId, noteId || `new:${noteDialogParentId}`);
  const base = { title: noteInlineTitleInput.value, content: noteInlineEditor.value };
  const cached = readNoteDraft(key);
  noteEdit = pendingNoteEdits.get(key) || {
    key, id: noteId, uid: currentUser.uid, workspaceId: activeWorkspaceId,
    base, value: cached || base, local: Boolean(cached)
  };
  noteInlineTitleInput.value = noteEdit.value.title;
  noteInlineEditor.value = noteEdit.value.content;
  updateNoteStatus(noteEdit);
  if (cached && noteId) scheduleNoteSync(noteEdit);
  setPreviewMode(!phoneLayout.matches);
  showFormatToolbar(false);
  updateLivePreview();
}

const livePreview = document.getElementById("note-live-preview");
const formatToolbar = document.getElementById("note-format-toolbar");
const formatToggle = document.getElementById("note-format-toggle");
const previewToggle = document.getElementById("note-preview-toggle");
const noteSaveStatus = document.getElementById("note-save-status");
const pendingNoteEdits = new Map();
let noteEdit;
let previewFrame;

function isEditingNote() {
  return !noteEditorWrapper.classList.contains("hidden");
}

function noteDraftKey(workspaceId, noteId) {
  return `plop.draft:${currentUser.uid}:${workspaceId}:${noteId}`;
}

function draftsForWorkspace(workspaceId) {
  const prefix = noteDraftKey(workspaceId, "");
  const drafts = new Map();
  try {
    for (const key of Object.keys(localStorage)) {
      if (!key.startsWith(prefix)) continue;
      const id = key.slice(prefix.length);
      if (!id.startsWith("new:")) drafts.set(id, key);
    }
  } catch {}
  return drafts;
}

function readNoteDraft(key) {
  try {
    const draft = JSON.parse(localStorage.getItem(key));
    return typeof draft?.title === "string" && typeof draft.content === "string" ? draft : null;
  } catch {
    return null;
  }
}

function sameNote(a, b) {
  return a?.title === b?.title && a?.content === b?.content;
}

function clearNoteDraft(edit, saved) {
  if (!sameNote(readNoteDraft(edit.key), saved)) return;
  try { localStorage.removeItem(edit.key); } catch {}
}

function updateNoteStatus(edit, message) {
  if (noteEdit !== edit || !isEditingNote()) return;
  noteSaveStatus.textContent = message || (sameNote(edit.base, edit.value) ? "" :
    edit.local ? (navigator.onLine ? "Saved on this device" : "Offline · saved on this device") :
    "Local storage unavailable");
}

function keepNoteDraft() {
  if (!isEditingNote() || !noteEdit) return;
  const edit = noteEdit;
  const value = { title: noteInlineTitleInput.value, content: noteInlineEditor.value };
  if (!sameNote(edit.value, value)) {
    edit.value = value;
    if (sameNote(edit.base, value) && !edit.syncing) {
      try { localStorage.removeItem(edit.key); } catch {}
      edit.local = false;
    } else {
      try {
        localStorage.setItem(edit.key, JSON.stringify(value));
        edit.local = true;
      } catch {
        edit.local = false;
      }
    }
    if (edit.id) scheduleNoteSync(edit);
  }
  updateNoteStatus(edit);
}

function scheduleNoteSync(edit) {
  pendingNoteEdits.set(edit.key, edit);
  clearTimeout(edit.timer);
  edit.timer = setTimeout(() => syncNoteDraft(edit), 800);
}

function syncNoteDraft(edit) {
  if (!edit.id || edit.syncing) return;
  if (currentUser?.uid !== edit.uid || sameNote(edit.base, edit.value)) {
    pendingNoteEdits.delete(edit.key);
    return;
  }
  const draft = edit.value;
  if (draft.content.length > 100000 || draft.title.length > 200) {
    updateNoteStatus(edit, "Note exceeds the sync limit");
    pendingNoteEdits.delete(edit.key);
    return;
  }
  const data = {};
  if (draft.title !== edit.base.title) data.title = draft.title.trim() || "Untitled Note.md";
  if (draft.content !== edit.base.content) data.content = draft.content;
  edit.syncing = true;
  pendingNoteEdits.set(edit.key, edit);
  updateDoc(doc(db, "workspaces", edit.workspaceId, "items", edit.id), data).then(() => {
    edit.base = draft;
    clearNoteDraft(edit, draft);
    updateNoteStatus(edit, sameNote(edit.value, draft) ? "Synced" : "");
  }).catch(() => {
    updateNoteStatus(edit, edit.local ? "Sync failed · draft kept on this device" : "Save failed");
  }).finally(() => {
    edit.syncing = false;
    pendingNoteEdits.delete(edit.key);
    if (!sameNote(draft, edit.value)) scheduleNoteSync(edit);
  });
}

function canLeaveNote() {
  if (!isEditingNote() || !noteEdit) return true;
  keepNoteDraft();
  if (sameNote(noteEdit.base, noteEdit.value) || noteEdit.local) return true;
  return window.confirm("These edits could not be saved locally. Leave this note?");
}

window.addEventListener("online", () => {
  if (isEditingNote() && noteEdit) {
    updateNoteStatus(noteEdit);
    syncNoteDraft(noteEdit);
  }
});
window.addEventListener("offline", () => {
  if (isEditingNote() && noteEdit) updateNoteStatus(noteEdit);
});

function setPreviewMode(enabled) {
  noteEditorWrapper.classList.toggle("show-live-preview", enabled);
  previewToggle.setAttribute("aria-pressed", String(enabled));
  previewToggle.textContent = enabled
    ? (phoneLayout.matches ? "Write" : "Hide preview")
    : "Preview";
}

function showFormatToolbar(visible) {
  formatToolbar.classList.toggle("hidden", !visible);
  formatToggle.setAttribute("aria-expanded", String(visible));
}

function updateLivePreview() {
  cancelAnimationFrame(previewFrame);
  previewFrame = requestAnimationFrame(() => renderMarkdown(livePreview, noteInlineEditor.value));
}

function replaceNoteSelection(edit) {
  noteInlineEditor.setSelectionRange(edit.start, edit.end);
  noteInlineEditor.focus();
  if (!document.execCommand("insertText", false, edit.text)) {
    noteInlineEditor.setRangeText(edit.text, edit.start, edit.end);
  }
  noteInlineEditor.setSelectionRange(edit.selectionStart, edit.selectionEnd);
  keepNoteDraft();
  updateLivePreview();
}

noteInlineEditor.addEventListener("input", () => {
  keepNoteDraft();
  updateLivePreview();
});
noteInlineTitleInput.addEventListener("input", keepNoteDraft);

async function clipboardImageMarkdown(file, limit) {
  if (file.size > 20 * 1024 * 1024) throw new Error("Paste an image smaller than 20 MB.");
  if (limit < 512) throw new Error("This note has too little space for an image.");
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  const scale = Math.min(1, 1200 / Math.max(bitmap.width, bitmap.height));
  try {
    for (const shrink of [1, 0.75, 0.5, 0.35, 0.25]) {
      canvas.width = Math.max(1, Math.round(bitmap.width * scale * shrink));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale * shrink));
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      for (const quality of [0.85, 0.66, 0.46]) {
        const uri = canvas.toDataURL("image/webp", quality);
        const markdown = `\n\n![Pasted image](${uri})\n\n`;
        if (markdown.length <= limit) return markdown;
      }
    }
  } finally {
    bitmap.close();
  }
  throw new Error("This image is too large for the remaining space in the note.");
}

noteInlineEditor.addEventListener("paste", async (event) => {
  const image = [...(event.clipboardData?.files || [])].find((file) => /^image\/(png|jpeg|webp|gif)$/i.test(file.type));
  if (!image || !isEditingNote()) return;
  event.preventDefault();
  const edit = noteEdit;
  try {
    const remainingSpace = 100000 - noteInlineEditor.value.length +
      (noteInlineEditor.selectionEnd - noteInlineEditor.selectionStart);
    const text = await clipboardImageMarkdown(image, remainingSpace);
    if (noteEdit !== edit || !isEditingNote()) return;
    const { value, selectionStart: start, selectionEnd: end } = noteInlineEditor;
    if (value.length - (end - start) + text.length > 100000) throw new Error("This note has too little space for the image.");
    replaceNoteSelection({ start, end, text, selectionStart: start + text.length, selectionEnd: start + text.length });
  } catch (error) {
    if (noteEdit === edit && isEditingNote()) showToast(error.message || "Could not paste this image.", "error");
  }
});
noteInlineEditor.addEventListener("select", () => {
  if (noteInlineEditor.selectionStart !== noteInlineEditor.selectionEnd) showFormatToolbar(true);
});
formatToggle.addEventListener("click", () => showFormatToolbar(formatToolbar.classList.contains("hidden")));
previewToggle.addEventListener("click", () => {
  const enabled = !noteEditorWrapper.classList.contains("show-live-preview");
  setPreviewMode(enabled);
  if (enabled) livePreview.focus();
  else noteInlineEditor.focus();
});
formatToolbar.addEventListener("mousedown", (event) => {
  if (event.target.closest("button")) event.preventDefault();
});
formatToolbar.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-format]");
  if (!button) return;
  const { value, selectionStart, selectionEnd } = noteInlineEditor;
  replaceNoteSelection(formatMarkdown(value, selectionStart, selectionEnd, button.dataset.format));
});

activeNoteEditBtn?.addEventListener("click", () => {
  if (!currentPreviewItem || currentPreviewItem.type !== "note") return;
  openInlineNoteEditor(currentPreviewItem.id);
});

activeNoteShareBtn?.addEventListener("click", () => {
  if (!currentPreviewItem || currentPreviewItem.type !== "note") return;
  openNoteShareDialog(currentPreviewItem.id);
});

activeNoteDiscardBtn?.addEventListener("click", () => {
  if (!canLeaveNote()) return;
  if (editingNoteId && workspaceItems[editingNoteId]) {
    showPreviewState(workspaceItems[editingNoteId]);
  } else {
    if (noteEdit?.local) showToast("Draft kept on this device.");
    currentPreviewItem = null;
    showEmptyState("Welcome to Plop", "Select a folder or link from the sidebar.");
  }
});

activeNoteSaveBtn?.addEventListener("click", async () => {
  if (!isEditingNote() || !noteEdit || activeNoteSaveBtn.disabled) return;
  keepNoteDraft();
  const edit = noteEdit;
  const data = { title: edit.value.title.trim() || "Untitled Note.md", content: edit.value.content };
  if (data.title.length > 200 || data.content.length > 100000) {
    updateNoteStatus(edit, "Note exceeds the sync limit");
    return;
  }
  if (edit.id) {
    syncNoteDraft(edit);
    if (edit.local || sameNote(edit.base, edit.value)) {
      showPreviewState({ ...workspaceItems[edit.id], ...data });
    }
    return;
  }

  const noteId = generateUUID();
  const note = buildNoteItem(noteId, data.title, data.content, noteDialogParentId);
  const draft = edit.value;
  const write = writeNoteItem(edit.workspaceId, note);
  const noteKey = noteDraftKey(edit.workspaceId, noteId);
  let local = false;
  try {
    localStorage.setItem(noteKey, JSON.stringify({ ...draft, recoveryKey: edit.key }));
    local = true;
    clearNoteDraft(edit, draft);
  } catch {}
  if (local) {
    workspaceItems[noteId] = note;
    selectedItemId = noteId;
    showPreviewState(note);
  } else {
    setButtonLoading(activeNoteSaveBtn, true, "Saving…");
  }
  try {
    await write;
    clearNoteDraft({ key: noteKey }, draft);
    clearNoteDraft(edit, draft);
    if (!local && noteEdit === edit && isEditingNote()) {
      workspaceItems[noteId] = note;
      selectedItemId = noteId;
      showPreviewState(note);
    }
  } catch (error) {
    if (noteEdit === edit && isEditingNote()) updateNoteStatus(edit, "Could not sync this note");
    else showToast("Could not sync this note. Your draft is still on this device.", "error");
    if (local && !readNoteDraft(edit.key)) {
      try {
        localStorage.setItem(edit.key, JSON.stringify(readNoteDraft(noteKey) || draft));
        localStorage.removeItem(noteKey);
      } catch {}
    }
  } finally {
    if (!local) setButtonLoading(activeNoteSaveBtn, false);
  }
});

// Double click rendered note to quickly edit
noteRenderedContent?.addEventListener("dblclick", () => {
  if (isSharedView || !currentPreviewItem || currentPreviewItem.type !== "note") return;
  openInlineNoteEditor(currentPreviewItem.id);
});

// Keep editing shortcuts scoped to the note.
noteEditorWrapper.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !formatToolbar.classList.contains("hidden")) {
    showFormatToolbar(false);
    noteInlineEditor.focus();
  }
  if (!(event.metaKey || event.ctrlKey)) return;
  if (event.key === "Enter") {
    event.preventDefault();
    activeNoteSaveBtn.click();
  }
  const style = { b: "bold", i: "italic", u: "underline" }[event.key.toLowerCase()];
  if (style && !event.shiftKey && !event.altKey && event.target === noteInlineEditor ) {
    event.preventDefault();
    const { value, selectionStart, selectionEnd } = noteInlineEditor;
    replaceNoteSelection(formatMarkdown(value, selectionStart, selectionEnd, style));
  }
});

noteInlineTitleInput.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  if (event.metaKey || event.ctrlKey) activeNoteSaveBtn.click();
  else noteInlineEditor.focus();
});

// Copy URL from header (both URL bar copy button & action icon)
function copyCurrentPreviewLink() {
  if (!currentPreviewItem) return;
  if (currentPreviewItem.url) {
    navigator.clipboard.writeText(currentPreviewItem.url)
      .then(() => showToast("URL copied to clipboard!", "success"))
      .catch(() => showToast("Could not access clipboard.", "error"));
  } else if (currentPreviewItem.type === "note") {
    if (currentPreviewItem.sharedVia) {
      const shareUrl = `${window.location.origin}${window.location.pathname}?f=${currentPreviewItem.sharedVia}`;
      navigator.clipboard.writeText(shareUrl)
        .then(() => showToast("Note link copied to clipboard!", "success"))
        .catch(() => showToast("Could not access clipboard.", "error"));
    } else {
      navigator.clipboard.writeText(currentPreviewItem.content || currentPreviewItem.title)
        .then(() => showToast("Note content copied to clipboard!", "success"))
        .catch(() => showToast("Could not access clipboard.", "error"));
    }
  }
}

urlBarCopyBtn?.addEventListener("click", copyCurrentPreviewLink);

document.getElementById("preview-toggle-viewer")?.addEventListener("click", () => {
  if (!currentPreviewItem) return;
  const nextMode = currentPreviewMode === "viewer" ? "direct" : "viewer";
  if (iframeBlockedWarn) iframeBlockedWarn.classList.add("hidden");
  setPreviewIframeSrc(currentPreviewItem.url, nextMode);
});

document.getElementById("warning-try-viewer")?.addEventListener("click", () => {
  if (!currentPreviewItem) return;
  if (iframeBlockedWarn) iframeBlockedWarn.classList.add("hidden");
  setPreviewIframeSrc(currentPreviewItem.url, "viewer");
});

document.getElementById("preview-back-btn")?.addEventListener("click", () => {
  if (!canLeaveNote()) return;
  selectedItemId = null;
  previewIframe.src = "about:blank";
  currentPreviewItem = null;
  showEmptyState("Welcome to Plop", "Select a folder or link from the sidebar.");
});

// ─────────────────────────────────────────────────────────────────────
// DRAG & DROP — GLOBAL MANAGER
// ─────────────────────────────────────────────────────────────────────

treeRoot.addEventListener("dragover", (e) => {
  if (!isSharedView && e.dataTransfer?.types.includes("Files")) e.preventDefault();
  if (!draggedItemId) return;
  e.preventDefault();

  const itemEl = e.target.closest(".tree-item");
  if (!itemEl || itemEl.dataset.id === draggedItemId || isDescendantOf(itemEl.dataset.id, draggedItemId)) {
    clearDropVisuals();
    currentDropTarget = null;
    return;
  }

  const id   = itemEl.dataset.id;
  const item = workspaceItems[id];
  const rect = itemEl.getBoundingClientRect();
  const pct  = (e.clientY - rect.top) / rect.height;

  let zone;
  if (item?.type === "folder" && pct > 0.25 && pct < 0.75) {
    zone = "inside";
  } else {
    zone = pct < 0.5 ? "before" : "after";
  }

  // Only update visuals if target changed
  if (currentDropTarget?.id !== id || currentDropTarget?.zone !== zone) {
    currentDropTarget = { id, zone };
    document.querySelectorAll(".drag-over-inside").forEach(el => el.classList.remove("drag-over-inside"));

    if (zone === "inside") {
      itemEl.classList.add("drag-over-inside");
      dropIndicator.classList.add("hidden");
    } else {
      const indicatorY = zone === "before" ? rect.top : rect.bottom;
      dropIndicator.style.top   = `${indicatorY - 1}px`;
      dropIndicator.style.left  = `${rect.left}px`;
      dropIndicator.style.width = `${rect.width}px`;
      dropIndicator.classList.remove("hidden");
    }
  }
});

treeRoot.addEventListener("drop", async (e) => {
  e.preventDefault();

  const file = e.dataTransfer?.files?.[0];
  if (file) {
    const rowId = e.target.closest(".tree-item")?.dataset.id;
    const parent = workspaceItems[rowId]?.type === "folder" ? rowId : "root";
    clearDropVisuals();
    await importFile(file, parent);
    return;
  }

  if (!currentDropTarget || !draggedItemId) return;

  const { id: targetId, zone } = currentDropTarget;
  const sourceId = draggedItemId;
  draggedItemId  = null;
  clearDropVisuals();

  if (sourceId === targetId) return;
  await moveItem(sourceId, targetId, zone);
});

treeRoot.addEventListener("dragleave", (e) => {
  if (!treeRoot.contains(e.relatedTarget)) clearDropVisuals();
});

document.addEventListener("dragend", clearDropVisuals);

function clearDropVisuals() {
  dropIndicator.classList.add("hidden");
  document.querySelectorAll(".drag-over-inside").forEach(el => el.classList.remove("drag-over-inside"));
  currentDropTarget = null;
}

// Move sourceId relative to targetId with given zone ('before'|'after'|'inside')
async function moveItem(sourceId, targetId, zone) {
  const sourceItem = workspaceItems[sourceId];
  const targetItem = workspaceItems[targetId];
  if (!sourceItem || !targetItem) return;

  const oldParentId = sourceItem.parentId;
  const batch = writeBatch(db);

  // Determine new parent
  let newParentId;
  if (zone === "inside") {
    newParentId = targetId;
  } else {
    newParentId = targetItem.parentId;
  }

  if (newParentId === sourceId || isDescendantOf(newParentId, sourceId)) return;
  if (oldParentId !== newParentId) removeFromParent(batch, sourceId, oldParentId);

  // 2. Add to new parent
  if (zone === "inside") {
    batch.update(doc(db, "workspaces", activeWorkspaceId, "items", targetId), { childrenIds: arrayUnion(sourceId) });
  } else {
    addToParentAtPosition(batch, sourceId, targetId, newParentId, zone === "after");
  }

  // 3. Determine sharedVia for new location
  let newSharedVia = null;
  if (zone === "inside") {
    newSharedVia = targetItem.sharedVia || null;
  } else if (newParentId !== "root") {
    newSharedVia = workspaceItems[newParentId]?.sharedVia || null;
  }

  // 4. Update source item: parentId + sharedVia
  const srcUpdate = { parentId: newParentId };
  if (newSharedVia) {
    srcUpdate.sharedVia = newSharedVia;
  } else if (sourceItem.sharedVia) {
    srcUpdate.sharedVia = deleteField();
  }
  batch.update(doc(db, "workspaces", activeWorkspaceId, "items", sourceId), srcUpdate);

  // 5. Propagate sharedVia change to all descendants of source
  propagateSharedVia(batch, sourceId, newSharedVia);

  try {
    await batch.commit();
  } catch (err) {
    console.error("Move failed:", err);
  }
}

function parentDocument(workspaceId, parentId) {
  const path = ["workspaces", workspaceId];
  if (parentId !== "root") path.push("items", parentId);
  return doc(db, ...path);
}

function removeFromParent(batch, itemId, parentId) {
  if (parentId === "root" || workspaceItems[parentId]) {
    batch.update(parentDocument(activeWorkspaceId, parentId), { childrenIds: arrayRemove(itemId) });
  }
}

function addToParentAtPosition(batch, sourceId, targetId, parentId, insertAfter) {
  let children;
  if (parentId === "root") {
    children = [...(activeWorkspace.childrenIds || [])].filter(id => id !== sourceId);
    const idx = children.indexOf(targetId);
    children.splice(Math.max(0, insertAfter ? idx + 1 : idx), 0, sourceId);
    batch.update(doc(db, "workspaces", activeWorkspaceId), { childrenIds: children });
  } else {
    const parent = workspaceItems[parentId];
    if (parent) {
      children = [...(parent.childrenIds || [])].filter(id => id !== sourceId);
      const idx = children.indexOf(targetId);
      children.splice(Math.max(0, insertAfter ? idx + 1 : idx), 0, sourceId);
      batch.update(doc(db, "workspaces", activeWorkspaceId, "items", parentId), { childrenIds: children });
    }
  }
}

// Propagate sharedVia change to all descendants of folderId
function propagateSharedVia(batch, folderId, sharedVia) {
  for (const childId of getAllDescendants(folderId)) {
    const child = workspaceItems[childId];
    if ((child.sharedVia || null) === sharedVia) continue;
    batch.update(doc(db, "workspaces", activeWorkspaceId, "items", childId), {
      sharedVia: sharedVia || deleteField()
    });
  }
}

// ─────────────────────────────────────────────────────────────────────
// CONTEXT MENUS
// ─────────────────────────────────────────────────────────────────────

function showContextMenu(itemId, clientX, clientY, itemType) {
  if (spaceContextMenu.matches(":popover-open")) spaceContextMenu.hidePopover();

  contextMenuTargetId = itemId;
  const isFolder = itemType === "folder";
  const item = workspaceItems[itemId];
  const isNote = itemType === "note";

  // Visibility of menu items based on item type and ownership
  document.getElementById("ctx-add-link")?.classList.toggle("hidden",      !isFolder);
  document.getElementById("ctx-add-note")?.classList.toggle("hidden",      !isFolder);
  document.getElementById("ctx-upload-file")?.classList.toggle("hidden",     !isFolder);
  document.getElementById("ctx-add-subfolder")?.classList.toggle("hidden", !isFolder);
  document.getElementById("ctx-share")?.classList.toggle("hidden",        !isFolder);
  document.getElementById("ctx-share-note")?.classList.toggle("hidden",   !isNote);
  document.getElementById("ctx-copy-link")?.classList.toggle("hidden",    isFolder);

  // In shared/viewer context: hide Edit and Delete for notes so viewers can't modify
  const ownerOnlyActions = ["ctx-rename", "ctx-delete"];
  ownerOnlyActions.forEach(id => {
    document.getElementById(id)?.classList.toggle("hidden", isSharedView);
  });

  document.getElementById("ctx-move-space").classList.toggle("hidden", isSharedView);
  document.getElementById("ctx-folder-to-space").classList.toggle("hidden", isSharedView || !isFolder);

  // Label: "Rename" for folders, "Edit" for links & notes
  document.getElementById("ctx-rename-label").textContent = isFolder ? "Rename" : "Edit";

  positionPopover(itemContextMenu, clientX, clientY);
  itemContextMenu.showPopover();
}

function showSpaceContextMenu(clientX, clientY) {
  if (itemContextMenu.matches(":popover-open")) itemContextMenu.hidePopover();

  positionPopover(spaceContextMenu, clientX, clientY);
  spaceContextMenu.showPopover();
}

function positionPopover(el, x, y) {
  el.style.left = "0px";
  el.style.top  = "0px";
  el.style.removeProperty("right");
  el.style.removeProperty("bottom");

  // Temporarily show off-screen to get dimensions
  el.style.visibility = "hidden";
  el.showPopover?.();

  const w = el.offsetWidth  || 180;
  const h = el.offsetHeight || 200;

  el.hidePopover?.();
  el.style.visibility = "";

  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const left = x + w > vw ? vw - w - 8 : x;
  const top  = y + h > vh ? y - h       : y;

  el.style.left = `${Math.max(4, left)}px`;
  el.style.top  = `${Math.max(4, top)}px`;
}

// Right-click on sidebar background (not on a tree item)
treeScrollContainer.addEventListener("contextmenu", (e) => {
  if (isSharedView || !activeWorkspace || e.target.closest(".tree-item")) return;
  e.preventDefault();
  showSpaceContextMenu(e.clientX, e.clientY);
});

// Close popovers manually when clicking/mousedown elsewhere
document.addEventListener("mousedown", (e) => {
  if (!e.target.closest("#item-context-menu") && !e.target.closest(".item-btn")) {
    try { itemContextMenu.hidePopover(); } catch (err) {}
  }
  if (!e.target.closest("#space-context-menu")) {
    try { spaceContextMenu.hidePopover(); } catch (err) {}
  }
});

// Close popovers manually when right-clicking outside the sidebar structure
document.addEventListener("contextmenu", (e) => {
  if (!e.target.closest(".tree-item") && !e.target.closest("#tree-scroll-container")) {
    try { itemContextMenu.hidePopover(); } catch (err) {}
    try { spaceContextMenu.hidePopover(); } catch (err) {}
  }
});

// Close popovers on Escape key press
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    try { itemContextMenu.hidePopover(); } catch (err) {}
    try { spaceContextMenu.hidePopover(); } catch (err) {}
  }
});

// Space context menu actions
document.getElementById("sctx-new-folder").addEventListener("click", () => {
  spaceContextMenu.hidePopover();
  folderDialogParentId = "root";
  document.getElementById("folder-dialog-title").textContent = "New Folder";
  document.getElementById("folder-title-input").value = "";
  folderDialog.showModal();
  document.getElementById("folder-title-input").focus();
});

document.getElementById("sctx-add-note")?.addEventListener("click", () => {
  spaceContextMenu.hidePopover();
  openInlineNoteEditor(null, "root");
});

document.getElementById("sctx-upload-file")?.addEventListener("click", () => {
  spaceContextMenu.hidePopover();
  noteDialogParentId = "root";
  documentFileInput.click();
});

document.getElementById("sctx-add-link").addEventListener("click", () => {
  spaceContextMenu.hidePopover();
  linkDialogParentId = "root";
  document.getElementById("link-url-input").value = "";
  document.getElementById("link-title-input").value = "";
  document.getElementById("link-dialog-title").textContent = "Add Link";
  linkDialog.showModal();
});

// ─────────────────────────────────────────────────────────────────────
// ITEM CONTEXT MENU ACTIONS
// ─────────────────────────────────────────────────────────────────────

// Item context menu actions
document.getElementById("ctx-add-link").addEventListener("click", () => {
  itemContextMenu.hidePopover();
  linkDialogParentId = contextMenuTargetId;
  document.getElementById("link-url-input").value   = "";
  document.getElementById("link-title-input").value = "";
  document.getElementById("link-dialog-title").textContent = `Add Link in ${workspaceItems[contextMenuTargetId]?.title || "folder"}`;
  linkDialog.showModal();
  setTimeout(() => document.getElementById("link-url-input").focus(), 50);
});

document.getElementById("ctx-add-note")?.addEventListener("click", () => {
  itemContextMenu.hidePopover();
  const parentId = contextMenuTargetId && workspaceItems[contextMenuTargetId]?.type === "folder"
    ? contextMenuTargetId : "root";
  openInlineNoteEditor(null, parentId);
});

document.getElementById("ctx-upload-file")?.addEventListener("click", () => {
  itemContextMenu.hidePopover();
  noteDialogParentId = contextMenuTargetId && workspaceItems[contextMenuTargetId]?.type === "folder"
    ? contextMenuTargetId : "root";
  documentFileInput.click();
});

document.getElementById("ctx-add-subfolder").addEventListener("click", () => {
  itemContextMenu.hidePopover();
  folderDialogParentId = contextMenuTargetId;
  document.getElementById("folder-dialog-title").textContent = `New Sub-folder in ${workspaceItems[contextMenuTargetId]?.title || "folder"}`;
  document.getElementById("folder-title-input").value = "";
  folderDialog.showModal();
  setTimeout(() => document.getElementById("folder-title-input").focus(), 50);
});

document.getElementById("ctx-share").addEventListener("click", () => {
  itemContextMenu.hidePopover();
  openFolderShareDialog(contextMenuTargetId);
});

document.getElementById("ctx-share-note")?.addEventListener("click", () => {
  itemContextMenu.hidePopover();
  openNoteShareDialog(contextMenuTargetId);
});

document.getElementById("ctx-copy-link").addEventListener("click", () => {
  itemContextMenu.hidePopover();
  const item = workspaceItems[contextMenuTargetId];
  if (!item) return;

  if (item.url) {
    // Regular link — copy the URL
    navigator.clipboard.writeText(item.url)
      .then(() => showToast("URL copied to clipboard!", "success"))
      .catch(() => showToast("Could not access clipboard.", "error"));
  } else if (item.type === "note") {
    if (item.sharedVia) {
      // Note is shared — copy its public share link
      const shareUrl = `${window.location.origin}${window.location.pathname}?f=${item.sharedVia}`;
      navigator.clipboard.writeText(shareUrl)
        .then(() => showToast("Note link copied to clipboard!", "success"))
        .catch(() => showToast("Could not access clipboard.", "error"));
    } else {
      // Note is private — copy its markdown content
      navigator.clipboard.writeText(item.content || item.title)
        .then(() => showToast("Note content copied to clipboard!", "success"))
        .catch(() => showToast("Could not access clipboard.", "error"));
    }
  }
});

document.getElementById("ctx-rename").addEventListener("click", () => {
  itemContextMenu.hidePopover();
  const item = workspaceItems[contextMenuTargetId];
  if (item?.type === "note") {
    openInlineNoteEditor(contextMenuTargetId);
  } else {
    openEditDialog(contextMenuTargetId);
  }
});

document.getElementById("ctx-delete").addEventListener("click", () => {
  itemContextMenu.hidePopover();
  const item = workspaceItems[contextMenuTargetId];
  if (!item) return;
  document.getElementById("delete-confirm-title").textContent = `Delete "${item.title}"`;
  document.getElementById("delete-confirm-desc").textContent  =
    item.type === "folder"
      ? "This will permanently delete this folder and everything inside it."
      : "This will permanently delete this link.";
  deleteConfirmDialog.showModal();
});

// ─────────────────────────────────────────────────────────────────────
// ADD FOLDER BUTTON (footer)
// ─────────────────────────────────────────────────────────────────────

document.getElementById("add-folder-btn")?.addEventListener("click", () => {
  folderDialogParentId = "root";
  document.getElementById("folder-dialog-title").textContent = "New Folder";
  document.getElementById("folder-title-input").value = "";
  folderDialog.showModal();
  setTimeout(() => document.getElementById("folder-title-input").focus(), 50);
});

const moveSpaceDialog = document.getElementById("move-space-dialog");
const moveSpaceSubmit = document.getElementById("move-space-submit");
const moveSpaceCancel = document.getElementById("move-space-cancel");
let spaceMove;

function openSpaceMove(promote) {
  const id = contextMenuTargetId;
  const item = workspaceItems[id];
  if (isSharedView || !item || (promote && item.type !== "folder") || !canLeaveNote()) return;
  itemContextMenu.hidePopover();
  spaceMove = { id, promote, source: activeWorkspaceId };
  const destinations = spaces.filter((space) => space.id !== activeWorkspaceId);
  const select = document.getElementById("move-space-select");
  const name = document.getElementById("move-space-name");
  select.replaceChildren(...destinations.map((space) => new Option(space.title, space.id)));
  select.disabled = promote;
  name.required = promote;
  name.value = item.title.slice(0, 50);
  document.getElementById("move-space-title").textContent = promote ? "Turn into space" : "Move to space";
  document.getElementById("move-space-desc").textContent = promote
    ? `The contents of “${item.title}” will become the new space’s top-level items.`
    : destinations.length ? `Move “${item.title}” to the top level of another space.` : "Create another space before moving an item.";
  document.getElementById("move-space-destination").classList.toggle("hidden", promote);
  document.getElementById("move-space-name-group").classList.toggle("hidden", !promote);
  document.getElementById("move-space-shares").classList.toggle("hidden",
    ![id, ...getAllDescendants(id)].some((childId) => workspaceItems[childId]?.sharedVia === childId));
  document.getElementById("move-space-error").classList.add("hidden");
  moveSpaceSubmit.disabled = !promote && !destinations.length;
  moveSpaceSubmit.textContent = promote ? "Create space" : "Move";
  moveSpaceDialog.showModal();
}

document.getElementById("ctx-move-space").addEventListener("click", () => openSpaceMove(false));
document.getElementById("ctx-folder-to-space").addEventListener("click", () => openSpaceMove(true));
moveSpaceCancel.addEventListener("click", () => moveSpaceDialog.close());
moveSpaceDialog.addEventListener("cancel", (event) => {
  if (moveSpaceCancel.disabled) event.preventDefault();
});

async function moveItemsAcrossSpaces(source, id, destination, promote) {
  if (source === destination) throw new Error("Choose a different destination space.");
  const sourceItem = (itemId) => doc(db, "workspaces", source, "items", itemId);
  const targetSpace = parentDocument(destination, "root");
  const sourceSpace = parentDocument(source, "root");

  await runTransaction(db, async (transaction) => {
    const [rootSnapshot, destinationSnapshot] = await Promise.all([
      transaction.get(sourceItem(id)), transaction.get(targetSpace)
    ]);
    if (!rootSnapshot.exists() || !destinationSnapshot.exists()) throw new Error("The item or destination is unavailable.");
    const root = rootSnapshot.data();
    if (root.id !== id) throw new Error("The item has an invalid ID.");
    if (promote && root.type !== "folder") throw new Error("Only a folder can become a space.");
    const sourceParent = root.parentId === "root" ? sourceSpace : sourceItem(root.parentId);
    const parentSnapshot = await transaction.get(sourceParent);
    if (!parentSnapshot.data()?.childrenIds?.includes(id)) throw new Error("The item’s location changed. Try again.");

    const items = new Map([[id, root]]);
    let parents = [root];
    while (parents.length) {
      const children = parents.flatMap((item) => (item.childrenIds || []).map((childId) => ({ childId, parent: item.id })));
      if (items.size + children.length > 249) throw new Error("This folder is too large to move in one step. Move smaller folders first.");
      parents = [];
      const snapshots = await Promise.all(children.map(({ childId }) => transaction.get(sourceItem(childId))));
      snapshots.forEach((snapshot, position) => {
        const data = snapshot.data();
        if (!data || data.id !== snapshot.id || data.parentId !== children[position].parent || items.has(snapshot.id)) {
          throw new Error("This folder changed or contains an invalid item. Refresh and try again.");
        }
        items.set(snapshot.id, data);
        if (data.type === "folder") parents.push(data);
      });
    }

    for (const itemId of items.keys()) {
      if (readNoteDraft(noteDraftKey(source, itemId)) || pendingNoteEdits.has(noteDraftKey(source, itemId))) {
        throw new Error("Wait for note edits in this folder to sync before moving it.");
      }
    }
    const shareRefs = [...items.values()].filter((item) => item.sharedVia === item.id)
      .map((item) => doc(db, "sharedFolders", item.id));
    const shares = await Promise.all(shareRefs.map((reference) => transaction.get(reference)));
    const activeShares = shares.filter((snapshot) => snapshot.data()?.workspaceId === source);
    const transferIds = [...items.keys()].filter((itemId) => !promote || itemId !== id);
    const targetRefs = transferIds.map((itemId) => doc(db, "workspaces", destination, "items", itemId));
    const targetItems = await Promise.all(targetRefs.map((reference) => transaction.get(reference)));
    if (targetItems.some((snapshot) => snapshot.exists())) throw new Error("An item with the same ID is already in the destination.");
    if (items.size + transferIds.length + activeShares.length + 2 > 500) {
      throw new Error("This folder is too large to move in one step. Move smaller folders first.");
    }
    const rootIds = promote ? (root.childrenIds || []) : [id];
    if ((destinationSnapshot.data().childrenIds || []).length + rootIds.length > 500) {
      throw new Error("The destination space has reached its top-level item limit.");
    }

    // All reads above participate in the same transaction as the move.
    transferIds.forEach((itemId, index) => {
      const { sharedVia, ...item } = items.get(itemId);
      if (itemId === id || (promote && item.parentId === id)) item.parentId = "root";
      transaction.set(targetRefs[index], item);
    });
    for (const itemId of items.keys()) transaction.delete(sourceItem(itemId));
    for (const snapshot of activeShares) transaction.delete(snapshot.ref);
    transaction.update(sourceParent, { childrenIds: arrayRemove(id) });
    if (rootIds.length) transaction.update(targetSpace, { childrenIds: arrayUnion(...rootIds) });
  });
}

document.getElementById("move-space-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!spaceMove || moveSpaceSubmit.disabled) return;
  const { source, id, promote } = spaceMove;
  const title = document.getElementById("move-space-name").value.trim();
  if (promote && !title) return;
  const errorLabel = document.getElementById("move-space-error");
  errorLabel.classList.add("hidden");
  setButtonLoading(moveSpaceSubmit, true, "Moving…");
  moveSpaceCancel.disabled = true;

  let created;
  let moved = false;
  try {
    if (!navigator.onLine) throw new Error("Reconnect to move items between spaces.");
    if (promote) {
      created = await createWorkspace(title, activeWorkspace.authorName || "guest", activeWorkspace.themeColor || "purple", "");
    }
    const destination = created?.id || document.getElementById("move-space-select").value;
    if (!destination) throw new Error("Choose a destination space.");
    await moveItemsAcrossSpaces(source, id, destination, promote);
    moved = true;
    if (created) {
      if (!spaces.some((space) => space.id === destination)) spaces.push(created);
      loadWorkspace(destination);
    }
    moveSpaceDialog.close();
    showToast(promote ? "Space created." : "Moved to space.", "success");
  } catch (error) {
    if (created && !moved) {
      const reference = parentDocument(created.id, "root");
      await runTransaction(db, async (transaction) => {
        const snapshot = await transaction.get(reference);
        if (snapshot.exists() && !snapshot.data().childrenIds?.length) transaction.delete(reference);
      }).catch(() => {});
    }
    errorLabel.textContent = error.message;
    errorLabel.classList.remove("hidden");
  } finally {
    setButtonLoading(moveSpaceSubmit, false);
    moveSpaceCancel.disabled = false;
  }
});

// ─────────────────────────────────────────────────────────────────────
// FOLDER DIALOG
// ─────────────────────────────────────────────────────────────────────

document.getElementById("folder-cancel-btn").addEventListener("click", () => folderDialog.close());

const folderSaveBtn = document.getElementById("folder-save-btn");

folderDialog.querySelector("form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const title = document.getElementById("folder-title-input").value.trim();
  if (!title) return;

  setButtonLoading(folderSaveBtn, true, "Creating...");

  const folderId = generateUUID();
  const parentId = folderDialogParentId;
  const batch    = writeBatch(db);

  // Determine sharedVia if parent is shared
  const sharedVia = parentId === "root" ? null : (workspaceItems[parentId]?.sharedVia || null);

  const folderDoc = {
    id: folderId,
    parentId,
    type: "folder",
    title,
    childrenIds: [],
    createdAt: Date.now(),
    ...(sharedVia ? { sharedVia } : {})
  };

  batch.set(doc(db, "workspaces", activeWorkspaceId, "items", folderId), folderDoc);

  batch.update(parentDocument(activeWorkspaceId, parentId), { childrenIds: arrayUnion(folderId) });

  try {
    await batch.commit();
    showToast("Folder created!", "success");
    folderDialog.close();
  } catch (err) {
    console.error("Create folder failed:", err);
    showToast("Failed to create folder: " + err.message, "error");
  } finally {
    setButtonLoading(folderSaveBtn, false);
  }
});

// ─────────────────────────────────────────────────────────────────────
// LINK DIALOG
// ─────────────────────────────────────────────────────────────────────

document.getElementById("link-cancel-btn").addEventListener("click", () => linkDialog.close());

const linkSaveBtn = document.getElementById("link-save-btn");

// Shared helper — creates a link item in Firestore and returns { linkId, linkDoc }
async function createLinkItem(url, title, parentId) {
  const linkId   = generateUUID();
  const batch    = writeBatch(db);
  const sharedVia = parentId === "root" ? null : (workspaceItems[parentId]?.sharedVia || null);

  const linkDoc = {
    id: linkId,
    parentId,
    type: "link",
    title: title || getDomain(url),
    url,
    createdAt: Date.now(),
    ...(sharedVia ? { sharedVia } : {})
  };

  batch.set(doc(db, "workspaces", activeWorkspaceId, "items", linkId), linkDoc);

  batch.update(parentDocument(activeWorkspaceId, parentId), { childrenIds: arrayUnion(linkId) });

  await batch.commit();
  return { linkId, linkDoc };
}

linkDialog.querySelector("form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const rawUrl = document.getElementById("link-url-input").value.trim();
  const url    = normalizeUrl(rawUrl);
  const title  = document.getElementById("link-title-input").value.trim();
  if (!url) {
    showToast("Please enter a valid URL.", "error");
    return;
  }

  setButtonLoading(linkSaveBtn, true, "Saving...");

  try {
    const { linkId, linkDoc } = await createLinkItem(url, title, linkDialogParentId);
    showToast("Link added!", "success");
    linkDialog.close();
    workspaceItems[linkId] = linkDoc;
    selectedItemId = linkId;
    showPreviewState(linkDoc);
  } catch (err) {
    console.error("Create link failed:", err);
    showToast("Failed to add link: " + err.message, "error");
  } finally {
    setButtonLoading(linkSaveBtn, false);
  }
});

// ─────────────────────────────────────────────────────────────────────
// NOTE STORAGE & MARKDOWN UPLOADER
// ─────────────────────────────────────────────────────────────────────

function buildNoteItem(id, title, content, parentId) {
  const sharedVia = workspaceItems[parentId]?.sharedVia;
  return {
    id, parentId, type: "note", title, content, createdAt: Date.now(),
    ...(sharedVia ? { sharedVia } : {})
  };
}

function writeNoteItem(workspaceId, note) {
  const batch = writeBatch(db);
  batch.set(doc(db, "workspaces", workspaceId, "items", note.id), note);
  batch.update(parentDocument(workspaceId, note.parentId), { childrenIds: arrayUnion(note.id) });
  return batch.commit();
}

async function importFile(file, parent) {
  if (!activeWorkspace || isSharedView || !canLeaveNote()) return;
  const originSpace = activeWorkspaceId;
  const owner = currentUser.uid;
  const inSpace = () => activeWorkspaceId === originSpace && currentUser?.uid === owner && !isSharedView;
  const importParent = workspaceItems[parent]?.type === "folder" ? parent : "root";
  const format = file.name.split(".").pop()?.toLowerCase();
  const title = file.name.slice(0, 200);
  const toast = showToast(`Importing “${title}”…`, "loading", 0);
  try {
    if (["pdf", "docx"].includes(format)) {
      if (file.size > 25 * 1024 * 1024) throw new Error("Choose a PDF or DOCX file under 25 MB.");
      if (!navigator.onLine) throw new Error("Reconnect to upload this file to the cloud.");
      const item = { id: generateUUID(), type: "document", owner, space: originSpace, parent: importParent, title, format };
      const progress = document.createTextNode("");
      toast.lastChild.replaceWith(progress);
      await uploadCloudDocument(item, file, (message) => { progress.nodeValue = message; });
      if (inSpace()) {
        cloudDocuments.set(item.id, item);
        if (!isEditingNote()) {
          selectedItemId = item.id;
          showPreviewState(item);
        }
        renderTree(true);
      }
      showToast("File uploaded to the cloud.", "success");
    } else if (["md", "markdown", "txt"].includes(format)) {
      if (file.size > 400000) throw new Error("This text file is too large to import as a note.");
      const content = await file.text();
      if (content.length > 100000) throw new Error("This text file is too large to import as a note.");
      if (!inSpace()) throw new Error("Return to the original space and try again.");
      const note = buildNoteItem(generateUUID(), title, content, importParent);
      await writeNoteItem(originSpace, note);
      if (inSpace()) {
        workspaceItems[note.id] = note;
        if (!isEditingNote()) {
          selectedItemId = note.id;
          showPreviewState(note);
        }
      }
      showToast("Imported as a note.", "success");
    } else {
      throw new Error("Choose an MD, TXT, PDF, or DOCX file.");
    }
  } catch (error) {
    showToast(error.message || "Could not import this file.", "error");
  } finally {
    toast.remove();
  }
}

documentFileInput.addEventListener("change", (event) => {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (file) importFile(file, noteDialogParentId);
});

// ─────────────────────────────────────────────────────────────────────
// EDIT ITEM DIALOG (rename folder / edit link title+url)
// ─────────────────────────────────────────────────────────────────────

function openEditDialog(itemId) {
  const item = workspaceItems[itemId];
  if (!item) return;

  contextMenuTargetId = itemId;
  const isLink = item.type === "link";

  document.getElementById("edit-item-dialog-title").textContent    = isLink ? "Edit Link" : "Rename Folder";
  document.getElementById("edit-item-title-label").textContent     = isLink ? "Title" : "Name";
  document.getElementById("edit-item-title-input").value           = item.title;

  const urlGroup = document.getElementById("edit-item-url-group");
  const urlInput = document.getElementById("edit-item-url-input");

  if (isLink) {
    urlGroup.classList.remove("hidden");
    urlInput.value = item.url || "";
  } else {
    urlGroup.classList.add("hidden");
    urlInput.value = "";
  }

  editItemDialog.showModal();
  setTimeout(() => document.getElementById("edit-item-title-input").select(), 50);
}

document.getElementById("edit-item-cancel-btn").addEventListener("click", () => editItemDialog.close());

const editItemSaveBtn = document.getElementById("edit-item-save-btn");

editItemDialog.querySelector("form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const item  = workspaceItems[contextMenuTargetId];
  if (!item) { editItemDialog.close(); return; }

  const newTitle = document.getElementById("edit-item-title-input").value.trim();
  const newUrl   = document.getElementById("edit-item-url-input").value.trim();
  if (!newTitle) return;

  setButtonLoading(editItemSaveBtn, true, "Saving...");

  const updates = { title: newTitle };
  if (item.type === "link" && newUrl) updates.url = newUrl;

  try {
    await updateDoc(doc(db, "workspaces", activeWorkspaceId, "items", contextMenuTargetId), updates);
    showToast("Saved changes successfully!", "success");
    editItemDialog.close();
  } catch (err) {
    console.error("Edit failed:", err);
    showToast("Failed to save changes: " + err.message, "error");
  } finally {
    setButtonLoading(editItemSaveBtn, false);
  }
});

// ─────────────────────────────────────────────────────────────────────
// DELETE CONFIRM
// ─────────────────────────────────────────────────────────────────────

document.getElementById("delete-confirm-cancel-btn").addEventListener("click", () => deleteConfirmDialog.close());

const deleteConfirmBtn = document.getElementById("delete-confirm-btn");

document.getElementById("delete-confirm-btn").addEventListener("click", async () => {
  const targetId = contextMenuTargetId;
  const item = workspaceItems[targetId];
  if (!item) { deleteConfirmDialog.close(); return; }

  setButtonLoading(deleteConfirmBtn, true, "Deleting...");

  const batch = writeBatch(db);

  // Collect all descendant IDs
  const toDelete = [targetId, ...getAllDescendants(targetId)];
  toDelete.forEach(id => {
    batch.delete(doc(db, "workspaces", activeWorkspaceId, "items", id));
  });

  // Remove from parent's childrenIds
  removeFromParent(batch, targetId, item.parentId);

  // If this folder was shared, delete from sharedFolders too
  if (item.sharedVia === targetId) {
    batch.delete(doc(db, "sharedFolders", targetId));
  }

  try {
    await batch.commit();
    showToast("Deleted successfully!", "success");
    deleteConfirmDialog.close();
    if (selectedItemId === targetId || toDelete.includes(selectedItemId)) {
      selectedItemId = null;
      showEmptyState("Welcome to Plop", "Select a folder or link from the sidebar.");
    }
  } catch (err) {
    console.error("Delete failed:", err);
    showToast(`Delete failed: ${err.message}`, "error");
  } finally {
    setButtonLoading(deleteConfirmBtn, false);
  }
});

// ─────────────────────────────────────────────────────────────────────
// FOLDER SHARE DIALOG
// ─────────────────────────────────────────────────────────────────────

function openFolderShareDialog(folderId) {
  contextMenuTargetId = folderId;
  const item    = workspaceItems[folderId];
  const isShared = item?.sharedVia === folderId; // self-referencing = this IS the shared root

  document.getElementById("folder-share-desc").textContent =
    `Share "${item?.title || "this folder"}" publicly. Sub-folders and links inside are included.`;

  const toggle = document.getElementById("folder-share-toggle");
  toggle.checked = isShared;
  updateShareLinkSection(isShared, folderId);

  folderShareDialog.showModal();
}

function updateShareLinkSection(isShared, folderId) {
  const section = document.getElementById("folder-share-link-section");
  if (isShared) {
    section.classList.remove("hidden");
    const shareUrl = `${window.location.origin}${window.location.pathname}?f=${folderId}`;
    document.getElementById("folder-share-link-input").value = shareUrl;
  } else {
    section.classList.add("hidden");
  }
}

document.getElementById("folder-share-toggle").addEventListener("change", async (e) => {
  const folderId = contextMenuTargetId;
  const enable   = e.target.checked;

  e.target.disabled = true;
  try {
    await setFolderSharing(folderId, enable);
    updateShareLinkSection(enable, folderId);
  } catch (err) {
    console.error("Share toggle failed:", err);
    e.target.checked = !enable; // revert
  } finally {
    e.target.disabled = false;
  }
});

document.getElementById("folder-copy-link-btn").addEventListener("click", () => {
  const input = document.getElementById("folder-share-link-input");
  navigator.clipboard.writeText(input.value).then(() => {
    const btn = document.getElementById("folder-copy-link-btn");
    btn.textContent = "Copied!";
    setTimeout(() => { btn.textContent = "Copy"; }, 2000);
  });
});

document.getElementById("folder-share-close-btn").addEventListener("click", () => folderShareDialog.close());

async function setFolderSharing(folderId, enable) {
  const folder = workspaceItems[folderId];
  if (!folder) throw new Error("Folder not found");

  const batch = writeBatch(db);

  if (enable) {
    // Create sharedFolders entry
    batch.set(doc(db, "sharedFolders", folderId), {
      workspaceId: activeWorkspaceId,
      ownerId:     currentUser.uid,
      folderTitle: folder.title,
      authorName:  activeWorkspace?.authorName || currentUser.displayName || "guest",
      themeColor:  activeWorkspace?.themeColor || "purple",
      sharedAt:    serverTimestamp()
    });

    // Folder item gets sharedVia = folderId (self-reference = it is the share root)
    batch.update(doc(db, "workspaces", activeWorkspaceId, "items", folderId), {
      sharedVia: folderId
    });

    // All descendants get sharedVia = folderId
    propagateSharedVia(batch, folderId, folderId);
  } else {
    // Delete sharedFolders entry
    batch.delete(doc(db, "sharedFolders", folderId));

    // Remove sharedVia from folder + all descendants
    batch.update(doc(db, "workspaces", activeWorkspaceId, "items", folderId), {
      sharedVia: deleteField()
    });
    propagateSharedVia(batch, folderId, null);
  }

  await batch.commit();
}

// ─────────────────────────────────────────────────────────────────────
// SHARE NOTE — individual note sharing via sharedFolders registry
// ─────────────────────────────────────────────────────────────────────

function openNoteShareDialog(noteId) {
  contextMenuTargetId = noteId;
  const item = workspaceItems[noteId];
  const isShared = item?.sharedVia === noteId;

  document.getElementById("note-share-desc").textContent =
    `Make "${item?.title || "this note"}" publicly accessible. Anyone with the link can view it.`;

  const toggle = document.getElementById("note-share-toggle");
  toggle.checked = isShared;
  updateNoteShareLinkSection(isShared, noteId);
  noteShareDialog.showModal();
}

function noteFilename(title) {
  return (title || "Untitled note").replace(/\.(md|markdown|txt)$/i, "")
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "-").trim() || "Untitled note";
}

document.getElementById("note-export").addEventListener("click", async (event) => {
  const format = event.target.closest("[data-export]")?.dataset.export;
  const note = workspaceItems[contextMenuTargetId];
  if (!format || note?.type !== "note") return;
  const draft = readNoteDraft(noteDraftKey(activeWorkspaceId, note.id));
  const source = draft?.content ?? note.content ?? "";
  const filename = noteFilename(draft?.title || note.title);
  if (format === "md") {
    downloadBlob(new Blob([source], { type: "text/markdown;charset=utf-8" }), `${filename}.md`);
    return;
  }
  const output = document.createElement("article");
  output.className = "note-markdown-body note-export-output";
  document.body.append(output);
  const rendered = renderMarkdown(output, source);
  if (format === "txt") {
    const plainText = output.innerText.trim();
    output.remove();
    downloadBlob(new Blob([plainText + "\n"], { type: "text/plain;charset=utf-8" }), `${filename}.txt`);
    return;
  }

  noteShareDialog.close();
  const title = draft?.title || note.title;
  if (title && (output.firstElementChild?.tagName !== "H1" ||
      output.firstElementChild.textContent.trim() !== title.trim())) {
    const heading = document.createElement("h1");
    heading.textContent = title;
    output.prepend(heading);
  }
  await Promise.race([rendered, new Promise((resolve) => setTimeout(resolve, 1800))]);
  for (const image of output.querySelectorAll("img")) image.loading = "eager";
  await Promise.race([
    Promise.allSettled([document.fonts.ready, ...[...output.querySelectorAll("img")].map((image) => image.decode())]),
    new Promise((resolve) => setTimeout(resolve, 1800))
  ]);
  const previousTitle = document.title;
  document.body.classList.add("printing-note");
  document.title = filename;
  window.addEventListener("afterprint", () => {
    output.remove();
    document.body.classList.remove("printing-note");
    document.title = previousTitle;
  }, { once: true });
  window.print();
});

function updateNoteShareLinkSection(isShared, noteId) {
  const section = document.getElementById("note-share-link-section");
  if (isShared) {
    section.classList.remove("hidden");
    const shareUrl = `${window.location.origin}${window.location.pathname}?f=${noteId}`;
    document.getElementById("note-share-link-input").value = shareUrl;
  } else {
    section.classList.add("hidden");
  }
}

document.getElementById("note-share-toggle")?.addEventListener("change", async (e) => {
  const noteId = contextMenuTargetId;
  const enable = e.target.checked;
  e.target.disabled = true;

  try {
    const item = workspaceItems[noteId];
    if (!item) throw new Error("Note not found");

    const batch = writeBatch(db);

    if (enable) {
      batch.set(doc(db, "sharedFolders", noteId), {
        workspaceId: activeWorkspaceId,
        ownerId:     currentUser.uid,
        folderTitle: item.title,
        authorName:  activeWorkspace?.authorName || currentUser.displayName || "guest",
        themeColor:  activeWorkspace?.themeColor || "purple",
        sharedAt:    serverTimestamp()
      });
      batch.update(doc(db, "workspaces", activeWorkspaceId, "items", noteId), {
        sharedVia: noteId
      });
      item.sharedVia = noteId;
    } else {
      batch.delete(doc(db, "sharedFolders", noteId));
      batch.update(doc(db, "workspaces", activeWorkspaceId, "items", noteId), {
        sharedVia: deleteField()
      });
      delete item.sharedVia;
    }

    await batch.commit();
    updateNoteShareLinkSection(enable, noteId);
    showToast(enable ? "Public link created!" : "Public sharing disabled.", "success");
  } catch (err) {
    console.error("Note share toggle failed:", err);
    e.target.checked = !enable;
    showToast("Failed to update sharing: " + err.message, "error");
  } finally {
    e.target.disabled = false;
  }
});

document.getElementById("note-copy-link-btn")?.addEventListener("click", () => {
  const input = document.getElementById("note-share-link-input");
  navigator.clipboard.writeText(input.value).then(() => {
    const btn = document.getElementById("note-copy-link-btn");
    btn.textContent = "Copied!";
    setTimeout(() => { btn.textContent = "Copy"; }, 2000);
  });
});

document.getElementById("note-share-close-btn")?.addEventListener("click", () => noteShareDialog.close());

// ─────────────────────────────────────────────────────────────────────
// WORKSPACE SETTINGS DIALOG
// ─────────────────────────────────────────────────────────────────────

function openWorkspaceDialog(space) {
  creatingSpace = !space;
  spaceIconChanged = creatingSpace;
  document.getElementById("workspace-dialog-title").textContent = creatingSpace ? "New space" : "Space settings";
  document.getElementById("workspace-title-input").value = space?.title || "";
  document.getElementById("workspace-author-input").value = space?.authorName || "";
  selectedSpaceIcon = presetSpaceIcons.has(space && effectiveSpaceIcon(space)) ? effectiveSpaceIcon(space) : "preset-box";
  syncSpaceIconPicker();
  document.getElementById("workspace-error").classList.add("hidden");
  selectedThemeColor = space?.themeColor || "purple";
  syncThemeColorPicker(selectedThemeColor);
  workspaceDialog.showModal();
}

document.getElementById("rename-workspace-btn").addEventListener("click", () => {
  if (activeWorkspace && !isSharedView) openWorkspaceDialog(activeWorkspace);
});
document.getElementById("new-space").addEventListener("click", () => {
  if (currentUser && !isSharedView) openWorkspaceDialog(null);
});

document.getElementById("workspace-cancel-btn").addEventListener("click", () => workspaceDialog.close());

function syncSpaceIconPicker() {
  for (const button of spaceIconPicker.querySelectorAll("[data-icon]")) {
    button.setAttribute("aria-pressed", String(button.dataset.icon === selectedSpaceIcon));
  }
}

spaceIconPicker.addEventListener("click", (event) => {
  const button = event.target.closest("[data-icon]");
  if (!button) return;
  selectedSpaceIcon = button.dataset.icon;
  spaceIconChanged = true;
  syncSpaceIconPicker();
});

// Theme color dots
document.getElementById("theme-color-picker").querySelectorAll(".color-dot").forEach(dot => {
  dot.addEventListener("click", () => {
    selectedThemeColor = dot.dataset.color;
    syncThemeColorPicker(selectedThemeColor);
  });
});

function syncThemeColorPicker(color) {
  document.querySelectorAll(".color-dot").forEach(d => {
    const selected = d.dataset.color === color;
    d.classList.toggle("active", selected);
    d.setAttribute("aria-pressed", String(selected));
  });
}

document.getElementById("workspace-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!activeWorkspaceId || (creatingSpace && !canLeaveNote())) return;

  const title      = document.getElementById("workspace-title-input").value.trim();
  const authorName = document.getElementById("workspace-author-input").value.trim() ||
                     activeWorkspace?.authorName || "guest";
  const icon = selectedSpaceIcon;
  if (!title) return;

  const saveBtn = document.getElementById("workspace-save-btn");
  if (saveBtn.disabled) return;
  const errorEl = document.getElementById("workspace-error");
  saveBtn.textContent = "Saving…";
  saveBtn.disabled    = true;
  errorEl.classList.add("hidden");

  try {
    let savedSpace;
    let localIcon = false;
    if (creatingSpace) {
      try {
        savedSpace = await createWorkspace(title, authorName, selectedThemeColor, icon);
      } catch (error) {
        if (error.code !== "permission-denied") throw error;
        savedSpace = await createWorkspace(title, authorName, selectedThemeColor, "");
        localIcon = true;
      }
      if (!spaces.some((entry) => entry.id === savedSpace.id)) spaces.push(savedSpace);
    } else {
      savedSpace = activeWorkspace;
      const reference = doc(db, "workspaces", savedSpace.id);
      const changes = { title, authorName, themeColor: selectedThemeColor };
      const cloudIcon = icon === "preset-box" ? null : icon;
      if (!spaceIconChanged || cloudIcon === (savedSpace.icon || null)) {
        await updateDoc(reference, changes);
      } else {
        try {
          await updateDoc(reference, { ...changes, icon: cloudIcon || deleteField() });
        } catch (error) {
          if (error.code !== "permission-denied") throw error;
          await updateDoc(reference, changes);
          localIcon = true;
        }
      }
    }
    if (spaceIconChanged && !saveLocalSpaceIcon(savedSpace, localIcon ? icon : null) && localIcon) {
      throw new Error("This browser could not store your icon. Space details were saved.");
    }
    if (creatingSpace) loadWorkspace(savedSpace.id);
    if (activeWorkspace) showWorkspaceIdentity(activeWorkspace);
    renderSpaces();
    if (localIcon) showToast("Icon saved on this device. Cloud rules need the icon field to sync it.");
    workspaceDialog.close();
  } catch (err) {
    console.error("Workspace save error:", err);
    errorEl.textContent = `Save failed: ${err.message}`;
    errorEl.classList.remove("hidden");
  } finally {
    saveBtn.textContent = "Save";
    saveBtn.disabled    = false;
  }
});

// ─────────────────────────────────────────────────────────────────────
// ACCOUNT DIALOG
// ─────────────────────────────────────────────────────────────────────

document.getElementById("account-btn").addEventListener("click", () => accountDialog.showModal());
document.getElementById("account-close-btn-1").addEventListener("click", () => accountDialog.close());
document.getElementById("account-close-btn-2").addEventListener("click", () => accountDialog.close());

function updateAccountUI() {
  if (!currentUser) return;
  const isAnon = currentUser.isAnonymous;

  document.getElementById("account-logged-in").classList.toggle("hidden", isAnon);
  document.getElementById("account-anonymous").classList.toggle("hidden", !isAnon);
  document.getElementById("account-btn-label").textContent = isAnon ? "Sign In" : (currentUser.displayName || "Account");

  if (!isAnon) {
    document.getElementById("user-name").textContent  = currentUser.displayName || "Signed In";
    document.getElementById("user-email").textContent = currentUser.email || "";
    const photoEl = document.getElementById("user-photo");
    if (currentUser.photoURL) {
      photoEl.src = currentUser.photoURL;
      photoEl.classList.remove("hidden");
    }
  }
}

// Google Sign-In
document.getElementById("google-login-btn").addEventListener("click", async () => {
  const provider    = new GoogleAuthProvider();
  const accountErrEl = document.getElementById("account-error");
  accountErrEl.classList.add("hidden");

  try {
    if (auth.currentUser?.isAnonymous) {
      await linkWithPopup(auth.currentUser, provider);
    } else {
      await signInWithPopup(auth, provider);
    }
    accountDialog.close();
  } catch (err) {
    console.error("Auth error:", err);
    if (err.code === "auth/credential-already-in-use") {
      try {
        const cred = GoogleAuthProvider.credentialFromError(err);
        if (cred) {
          await signInWithCredential(auth, cred);
          accountDialog.close();
          return;
        }
        await signInWithPopup(auth, provider);
        accountDialog.close();
      } catch (fallbackErr) {
        accountErrEl.textContent = `Sign-in failed: ${fallbackErr.message}`;
        accountErrEl.classList.remove("hidden");
      }
    } else if (err.code !== "auth/popup-closed-by-user" && err.code !== "auth/cancelled-popup-request") {
      accountErrEl.textContent = `Sign-in failed: ${err.message}`;
      accountErrEl.classList.remove("hidden");
    }
  }
});

// Sign Out
document.getElementById("sign-out-btn").addEventListener("click", () => {
  accountDialog.close();
  signoutConfirmDialog.showModal();
});
document.getElementById("signout-confirm-cancel-btn").addEventListener("click", () => signoutConfirmDialog.close());
document.getElementById("signout-confirm-btn").addEventListener("click", async () => {
  signoutConfirmDialog.close();
  try {
    await signOut(auth);
  } catch (err) {
    console.error("Sign out error:", err);
  }
});

// ─────────────────────────────────────────────────────────────────────
// PASTE LINK — Cmd/Ctrl+V anywhere in sidebar
// ─────────────────────────────────────────────────────────────────────

window.addEventListener("keydown", async (e) => {
  const isInInput = ["INPUT", "TEXTAREA"].includes(document.activeElement?.tagName);
  if (isInInput) return;
  if (!((e.metaKey || e.ctrlKey) && e.key === "v")) return;
  if (isSharedView) return;

  try {
    const text = await navigator.clipboard.readText();
    if (!text) return;

    const urls = parseUrlsFromText(text);
    if (urls.length === 0) return;

    const parentId = selectedItemId && workspaceItems[selectedItemId]?.type === "folder"
      ? selectedItemId : "root";
    const parentName = parentId === "root" ? "workspace" : (workspaceItems[parentId]?.title || "folder");

    if (urls.length === 1) {
      // Single URL — open dialog pre-filled with normalized URL
      linkDialogParentId = parentId;
      document.getElementById("link-url-input").value   = urls[0];
      document.getElementById("link-title-input").value = "";
      document.getElementById("link-dialog-title").textContent = `Add Link in ${parentName}`;
      linkDialog.showModal();
      setTimeout(() => document.getElementById("link-title-input").focus(), 50);
    } else {
      // Multiple URLs — bulk add into target folder/root
      const toast = showToast(`Adding ${urls.length} links to ${parentName}…`, "loading", 0);
      try {
        const batch = writeBatch(db);
        const newLinkIds = [];
        const sharedVia = parentId === "root" ? null : (workspaceItems[parentId]?.sharedVia || null);

        for (const url of urls) {
          const linkId = generateUUID();
          newLinkIds.push(linkId);
          const linkDoc = {
            id: linkId,
            parentId,
            type: "link",
            title: getDomain(url),
            url,
            createdAt: Date.now(),
            ...(sharedVia ? { sharedVia } : {})
          };
          batch.set(doc(db, "workspaces", activeWorkspaceId, "items", linkId), linkDoc);

        }

        batch.update(parentDocument(activeWorkspaceId, parentId), { childrenIds: arrayUnion(...newLinkIds) });

        await batch.commit();
        toast.remove();
        showToast(`Added ${urls.length} links!`, "success");
      } catch (err) {
        toast.remove();
        console.error("Bulk add failed:", err);
        showToast("Bulk add failed: " + err.message, "error");
      }
    }
  } catch { /* clipboard denied */ }
});

// ─────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────

function generateUUID() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function getDomain(url) {
  try { return new URL(url).hostname.replace("www.", ""); } catch { return url; }
}

function isValidUrl(str) {
  try {
    const u = new URL(str);
    return (u.protocol === "http:" || u.protocol === "https:") && Boolean(u.hostname) && !u.username && !u.password && str.length <= 500;
  } catch {
    return false;
  }
}

// Normalise user-typed string (e.g. example.com, www.example.com, hello.example.com)
function normalizeUrl(str) {
  if (!str) return null;
  const trimmed = str.trim().replace(/^[<"']|[>"']$/g, "");
  if (!trimmed) return null;

  if (/^https?:\/\//i.test(trimmed)) {
    return isValidUrl(trimmed) ? trimmed : null;
  }

  // Must contain a dot and no spaces
  if (/^[a-zA-Z0-9][-a-zA-Z0-9]*(\.[a-zA-Z0-9][-a-zA-Z0-9]*)+(:[0-9]+)?(\/.*)?$/i.test(trimmed) ||
      /^localhost(:[0-9]+)?(\/.*)?$/i.test(trimmed)) {
    const candidate = "https://" + trimmed;
    return isValidUrl(candidate) ? candidate : null;
  }

  return null;
}

// Parse text separated by newlines, commas, semicolons, or spaces into valid URLs
function parseUrlsFromText(text) {
  if (!text) return [];
  const tokens = text.split(/[\r\n,;\s]+/).map(s => s.trim()).filter(Boolean);
  const results = new Set();
  for (const token of tokens) {
    const normalized = normalizeUrl(token);
    if (normalized) results.add(normalized);
    if (results.size === 500) break;
  }
  return [...results];
}

// Returns true if `targetId` is a descendant of `ancestorId`
function isDescendantOf(targetId, ancestorId) {
  const visited = new Set();
  while (targetId && targetId !== "root" && !visited.has(targetId)) {
    if (targetId === ancestorId) return true;
    visited.add(targetId);
    targetId = workspaceItems[targetId]?.parentId;
  }
  return false;
}

function getAllDescendants(folderId) {
  const visited = new Set([folderId]);
  const pending = [...(workspaceItems[folderId]?.childrenIds || [])];
  while (pending.length) {
    const id = pending.pop();
    const item = workspaceItems[id];
    if (!item || visited.has(id)) continue;
    visited.add(id);
    pending.push(...(item.childrenIds || []));
  }
  visited.delete(folderId);
  return [...visited];
}
