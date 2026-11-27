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
  getDoc, getDocs, setDoc, updateDoc, deleteDoc,
  onSnapshot, writeBatch, serverTimestamp, deleteField
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
let workspaceItems     = {};     // { [id]: itemData }
let unsubWorkspace     = null;
let unsubItems         = null;
let selectedItemId     = null;
let contextMenuTargetId = null;
let linkDialogParentId = "root";
let folderDialogParentId = "root";
let selectedThemeColor = "purple";
let spaces = [];
let unsubscribeSpaces;
let creatingSpace = false;
let savingNote = false;
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
const activeFavicon        = document.getElementById("active-favicon");
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
const noteDialog           = document.getElementById("note-dialog");
const markdownFileInput    = document.getElementById("markdown-file-input");
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
      unsubWorkspace?.();
      unsubItems?.();
      spaces = [];
      activeWorkspaceId = null;
      activeWorkspace = null;
      workspaceItems = {};
      selectedItemId = null;
      currentPreviewItem = null;
      previewIframe.src = "";
      treeRoot.textContent = "Loading your spaces…";
      spaceSwitcher.classList.add("hidden");
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

async function loadUserWorkspace() {
  unsubscribeSpaces?.();
  const user = currentUser;
  const ownedSpaces = query(collection(db, "workspaces"), where("ownerId", "==", user.uid));
  try {
    const snapshot = await getDocs(ownedSpaces);
    if (currentUser !== user) return;
    if (snapshot.empty) {
      const space = await createWorkspace("Bookmarks", user.displayName || "guest", "purple", "");
      if (currentUser !== user) return;
      spaces = [space];
    } else {
      readSpaces(snapshot);
    }
    const lastId = localStorage.getItem(`lf_active_ws_${user.uid}`);
    loadWorkspace(spaces.find((space) => space.id === lastId)?.id || spaces[0].id);
    unsubscribeSpaces = onSnapshot(ownedSpaces, (updated) => {
      if (currentUser === user && !isSharedView) readSpaces(updated);
    }, (error) => console.error("Could not sync spaces:", error));
  } catch (error) {
    treeRoot.textContent = "Could not load your spaces. Reload to try again.";
    console.error("Could not load spaces:", error);
  }
}

async function createWorkspace(title, authorName, themeColor, icon) {
  const id = generateUUID();
  const space = { id, ownerId: currentUser.uid, title, authorName, themeColor, childrenIds: [],
    ...(icon ? { icon } : {}) };
  await setDoc(doc(db, "workspaces", id), { ...space, createdAt: serverTimestamp() });
  return space;
}

function readSpaces(snapshot) {
  spaces = snapshot.docs.map((entry) => ({ ...entry.data(), id: entry.id }))
    .sort((a, b) => (a.createdAt?.seconds ?? Infinity) - (b.createdAt?.seconds ?? Infinity) ||
      a.id.localeCompare(b.id));
  renderSpaces();
}

function renderSpaces() {
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
    icon.textContent = space.icon || Array.from(space.title?.trim() || "◇")[0].toLocaleUpperCase();
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
  unsubWorkspace?.();
  unsubItems?.();

  isSharedView = false;
  sharedRootFolderId = null;
  sharedFolderData = null;
  activeWorkspaceId = wsId;
  activeWorkspace = null;
  workspaceItems = {};
  selectedItemId = null;
  currentPreviewItem = null;
  previewIframe.src = "";
  const space = spaces.find((entry) => entry.id === wsId);
  if (space) showWorkspaceIdentity(space);
  showEmptyState(space?.title || "Plop", "Choose a note or link, or add something to this space.");
  treeRoot.textContent = "";
  spaceSwitcher.classList.remove("hidden");
  addToSpace.classList.add("hidden");
  renderSpaces();

  localStorage.setItem(`lf_active_ws_${currentUser.uid}`, wsId);
  loadCollapsedState(wsId);

  // Live workspace doc
  unsubWorkspace = onSnapshot(doc(db, "workspaces", wsId), (snap) => {
    if (!snap.exists()) return;
    activeWorkspace = snap.data();
    showWorkspaceIdentity(activeWorkspace);
    addToSpace.classList.remove("hidden");
    renderTree(true);
  });

  // Live items subcollection
  unsubItems = onSnapshot(collection(db, "workspaces", wsId, "items"), (snap) => {
    workspaceItems = {};
    snap.forEach(d => { workspaceItems[d.id] = d.data(); });
    renderTree(true);
  });

  document.getElementById("rename-workspace-btn").classList.remove("hidden");
}

function showWorkspaceIdentity(space) {
  applyTheme(space.themeColor || "purple");
  document.getElementById("workspace-title-display").textContent = space.title;
  workspaceIcon.replaceChildren(space.icon || defaultWorkspaceIcon);
}

addToSpace.addEventListener("click", () => {
  const bounds = addToSpace.getBoundingClientRect();
  showSpaceContextMenu(bounds.left, bounds.bottom + 4);
});

// ─────────────────────────────────────────────────────────────────────
// SHARED FOLDER VIEW — VISITOR
// ─────────────────────────────────────────────────────────────────────

async function loadSharedFolderView(folderId) {
  if (unsubWorkspace) unsubWorkspace();
  if (unsubItems)     unsubItems();

  unsubscribeSpaces?.();
  spaceSwitcher.classList.add("hidden");
  addToSpace.classList.add("hidden");
  isSharedView       = true;
  sharedRootFolderId = folderId;
  workspaceItems     = {};

  treeRoot.innerHTML = `<div class="loading-spinner"><div class="spinner"></div><span>Loading shared folder…</span></div>`;

  const shareSnap = await getDoc(doc(db, "sharedFolders", folderId));
  if (!shareSnap.exists()) {
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
      workspaceItems = {};
      snap.forEach(d => { workspaceItems[d.id] = d.data(); });
      renderTree(false);
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
    const idMap   = {}; // oldId → newId for items

    // Ensure the user has a workspace; if not, this becomes it
    await setDoc(doc(db, "workspaces", newWsId), {
      id: newWsId,
      ownerId:    currentUser.uid,
      title:      `${sharedFolderData.folderTitle} (clone)`,
      authorName: currentUser.displayName || sharedFolderData.authorName || "guest",
      themeColor: sharedFolderData.themeColor || "purple",
      childrenIds: [],
      createdAt:  serverTimestamp()
    });

    // Remap IDs
    Object.keys(workspaceItems).forEach(oldId => { idMap[oldId] = generateUUID(); });
    const newRootFolderId = idMap[sharedRootFolderId];

    const batch = writeBatch(db);

    Object.values(workspaceItems).forEach(item => {
      const newId = idMap[item.id];
      const cloned = {
        id:        newId,
        parentId:  item.parentId === sharedRootFolderId ? "root" : (idMap[item.parentId] || item.parentId),
        type:      item.type,
        title:     item.title,
        createdAt: item.createdAt,
        ...(item.url        ? { url:        item.url }                             : {}),
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

  if (selectedItemId && !workspaceItems[selectedItemId]) {
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
  if (rootIds.length === 0) {
    if (!isEditingNote()) showEmptyState(activeWorkspace.title, "Add a note, link, or folder to get started.");
    return;
  }

  rootIds.forEach(itemId => {
    const item = workspaceItems[itemId];
    if (item && item.parentId === "root") {
      treeRoot.appendChild(renderNode(item, 0, true));
    }
  });

  if (isEditingNote()) return;

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

function renderNode(item, depth, isOwner) {
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
    const faviconEl = document.createElement("img");
    faviconEl.className = "link-favicon";
    faviconEl.src = `https://www.google.com/s2/favicons?domain=${getDomain(item.url)}&sz=32`;
    faviconEl.alt = "";
    faviconEl.onerror = () => { iconEl.innerHTML = renderIcon("link"); };
    iconEl.appendChild(faviconEl);
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
      if (child) childrenContainer.appendChild(renderNode(child, depth + 1, isOwner));
    });

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
  const viewerLabel = document.getElementById("viewer-toggle-label");
  if (viewerLabel) {
    viewerLabel.textContent = mode === "viewer" ? "Direct View" : "Web / PDF Viewer";
  }

  if (mode === "viewer") {
    previewIframe.src = getViewerUrl(url);
  } else {
    previewIframe.src = url;
  }
}

// Lightweight Markdown HTML Parser
function showPreviewState(item) {
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

    previewIframe.classList.add("hidden");
    if (notePreviewContainer) {
      notePreviewContainer.classList.remove("hidden");
      noteRenderedContent.classList.remove("hidden");
      if (noteEditorWrapper) noteEditorWrapper.classList.add("hidden");
      renderMarkdown(noteRenderedContent, item.content || "");
    }
  } else {
    // Show Link / WebView
    activeFavicon.src  = `https://www.google.com/s2/favicons?domain=${getDomain(item.url)}&sz=32`;
    activeTitle.textContent = item.title || item.url;
    activeUrl.textContent   = item.url;
    activeLinkOpen.href     = item.url;
    
    // Header elements
    sleekUrlBar.classList.remove("hidden");
    noteInlineTitleInput.classList.add("hidden");
    activeLinkOpen.classList.remove("hidden");
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
  previewState.classList.add("viewing-note", "editing-note");
  appContainer.classList.add("preview-active");
  appContainer.classList.remove("mobile-list-open", "mobile-canvas-open");
  syncSidebarToggle();

  editingNoteId = noteId;
  noteDialogParentId = (parentId && workspaceItems[parentId]?.type === "folder") ? parentId : "root";

  emptyState.classList.add("hidden");
  previewState.classList.remove("hidden");
  if (iframeBlockedWarn) iframeBlockedWarn.classList.add("hidden");
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
  originalNote = { title: noteInlineTitleInput.value, content: noteInlineEditor.value };
  setPreviewMode(!phoneLayout.matches);
  showFormatToolbar(false);
  updateLivePreview();
}

const livePreview = document.getElementById("note-live-preview");
const formatToolbar = document.getElementById("note-format-toolbar");
const formatToggle = document.getElementById("note-format-toggle");
const previewToggle = document.getElementById("note-preview-toggle");
const emojiToggle = document.getElementById("note-emoji-toggle");
const emojiPicker = document.getElementById("note-emojis");
let originalNote;
let previewFrame;

function isEditingNote() {
  return !noteEditorWrapper.classList.contains("hidden");
}

function canLeaveNote() {
  if (savingNote) return false;
  const dirty = isEditingNote() && originalNote &&
    (originalNote.title !== noteInlineTitleInput.value || originalNote.content !== noteInlineEditor.value);
  return !dirty || window.confirm("Discard unsaved changes to this note?");
}

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
  if (!visible) showEmojiPicker(false);
}

function showEmojiPicker(visible) {
  emojiPicker.classList.toggle("hidden", !visible);
  emojiToggle.setAttribute("aria-expanded", String(visible));
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
  updateLivePreview();
}

noteInlineEditor.addEventListener("input", updateLivePreview);
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
emojiToggle.addEventListener("click", () => showEmojiPicker(emojiPicker.classList.contains("hidden")));
formatToolbar.addEventListener("click", (event) => {
  const emoji = event.target.closest("button[data-emoji]")?.textContent;
  if (emoji && !savingNote) {
    const { selectionStart: start, selectionEnd: end } = noteInlineEditor;
    const caret = start + emoji.length;
    replaceNoteSelection({ start, end, text: emoji, selectionStart: caret, selectionEnd: caret });
    showEmojiPicker(false);
    return;
  }
  const button = event.target.closest("button[data-format]");
  if (!button || savingNote) return;
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
  if (savingNote) return;
  if (editingNoteId && workspaceItems[editingNoteId]) {
    showPreviewState(workspaceItems[editingNoteId]);
  } else {
    currentPreviewItem = null;
    showEmptyState("Welcome to Plop", "Select a folder or link from the sidebar.");
  }
});

activeNoteSaveBtn?.addEventListener("click", async () => {
  if (savingNote || !isEditingNote()) return;
  savingNote = true;
  noteInlineEditor.readOnly = true;
  noteInlineTitleInput.readOnly = true;
  const title = (noteInlineTitleInput?.value || "").trim() || "Untitled Note.md";
  const content = noteInlineEditor?.value || "";

  setButtonLoading(activeNoteSaveBtn, true, "Saving...");
  try {
    if (editingNoteId && workspaceItems[editingNoteId]) {
      // Update existing note
      await updateDoc(doc(db, "workspaces", activeWorkspaceId, "items", editingNoteId), {
        title,
        content
      });
      const updatedItem = { ...workspaceItems[editingNoteId], title, content };
      workspaceItems[editingNoteId] = updatedItem;
      currentPreviewItem = updatedItem;
      showToast("Note saved!", "success");
      showPreviewState(updatedItem);
    } else {
      // Create new note directly in viewer
      const { noteId: newNoteId, noteDoc } = await createNoteItem(title, content, noteDialogParentId);
      workspaceItems[newNoteId] = noteDoc;
      selectedItemId = newNoteId;
      currentPreviewItem = noteDoc;
      showToast("Note created!", "success");
      showPreviewState(noteDoc);
    }
  } catch (err) {
    console.error("Save note error:", err);
    showToast("Failed to save note: " + err.message, "error");
  } finally {
    savingNote = false;
    noteInlineEditor.readOnly = false;
    noteInlineTitleInput.readOnly = false;
    setButtonLoading(activeNoteSaveBtn, false);
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
  if (style && !event.shiftKey && !event.altKey && event.target === noteInlineEditor && !savingNote) {
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
  previewIframe.src = "";
  currentPreviewItem = null;
  showEmptyState("Welcome to Plop", "Select a folder or link from the sidebar.");
});

// ─────────────────────────────────────────────────────────────────────
// DRAG & DROP — GLOBAL MANAGER
// ─────────────────────────────────────────────────────────────────────

treeRoot.addEventListener("dragover", (e) => {
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

  // Handle desktop file drop (.md, .markdown, .txt)
  if (e.dataTransfer?.files?.length > 0) {
    const file = e.dataTransfer.files[0];
    const isMd = file.name.endsWith(".md") || file.name.endsWith(".markdown") || file.name.endsWith(".txt");
    if (isMd) {
      const targetFolderId = currentDropTarget?.id && workspaceItems[currentDropTarget.id]?.type === "folder"
        ? currentDropTarget.id : "root";
      clearDropVisuals();

      const reader = new FileReader();
      reader.onload = async (evt) => {
        try {
          await createNoteItem(file.name, evt.target.result || "", targetFolderId);
        } catch (err) {
          console.error("Drop markdown file failed:", err);
        }
      };
      reader.readAsText(file);
      return;
    }
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

  // Prevent no-op (same parent + same position edge case)
  if (oldParentId === newParentId && zone !== "inside") {
    // Still allow reorder within same parent
  }

  // 1. Remove from old parent
  removeFromParent(batch, sourceId, oldParentId);

  // 2. Add to new parent
  if (zone === "inside") {
    const newChildren = [...(targetItem.childrenIds || []).filter(id => id !== sourceId), sourceId];
    batch.update(doc(db, "workspaces", activeWorkspaceId, "items", targetId), { childrenIds: newChildren });
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
  propagateSharedVia(batch, sourceId, newSharedVia, true /* skip root, already handled */);

  try {
    await batch.commit();
  } catch (err) {
    console.error("Move failed:", err);
  }
}

function removeFromParent(batch, itemId, parentId) {
  if (parentId === "root") {
    const filtered = (activeWorkspace.childrenIds || []).filter(id => id !== itemId);
    batch.update(doc(db, "workspaces", activeWorkspaceId), { childrenIds: filtered });
  } else {
    const parent = workspaceItems[parentId];
    if (parent) {
      const filtered = (parent.childrenIds || []).filter(id => id !== itemId);
      batch.update(doc(db, "workspaces", activeWorkspaceId, "items", parentId), { childrenIds: filtered });
    }
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
function propagateSharedVia(batch, folderId, sharedVia, skipRoot = false) {
  if (!skipRoot) {
    const upd = sharedVia ? { sharedVia } : { sharedVia: deleteField() };
    batch.update(doc(db, "workspaces", activeWorkspaceId, "items", folderId), upd);
  }
  const item = workspaceItems[folderId];
  if (!item?.childrenIds) return;
  for (const childId of item.childrenIds) {
    const upd = sharedVia ? { sharedVia } : { sharedVia: deleteField() };
    batch.update(doc(db, "workspaces", activeWorkspaceId, "items", childId), upd);
    propagateSharedVia(batch, childId, sharedVia, false);
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
  document.getElementById("ctx-upload-md")?.classList.toggle("hidden",     !isFolder);
  document.getElementById("ctx-add-subfolder")?.classList.toggle("hidden", !isFolder);
  document.getElementById("ctx-share")?.classList.toggle("hidden",        !isFolder);
  document.getElementById("ctx-share-note")?.classList.toggle("hidden",   !isNote);
  document.getElementById("ctx-copy-link")?.classList.toggle("hidden",    isFolder);

  // In shared/viewer context: hide Edit and Delete for notes so viewers can't modify
  const ownerOnlyActions = ["ctx-rename", "ctx-delete"];
  ownerOnlyActions.forEach(id => {
    document.getElementById(id)?.classList.toggle("hidden", isSharedView);
  });

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

document.getElementById("sctx-upload-md")?.addEventListener("click", () => {
  spaceContextMenu.hidePopover();
  noteDialogParentId = "root";
  markdownFileInput.click();
});

document.getElementById("sctx-add-link").addEventListener("click", () => {
  spaceContextMenu.hidePopover();
  linkDialogParentId = "root";
  document.getElementById("link-url-input").value = "";
  document.getElementById("link-title-input").value = "";
  document.getElementById("link-dialog-title").textContent = "Add Link";
  linkDialog.showModal();
});

document.getElementById("sctx-paste-link").addEventListener("click", async () => {
  spaceContextMenu.hidePopover();
  try {
    const text = await navigator.clipboard.readText();
    if (text && isValidUrl(text)) {
      linkDialogParentId = selectedItemId && workspaceItems[selectedItemId]?.type === "folder"
        ? selectedItemId : "root";
      document.getElementById("link-url-input").value   = text;
      document.getElementById("link-title-input").value = "";
      document.getElementById("link-dialog-title").textContent = "Add Link";
      linkDialog.showModal();
      document.getElementById("link-title-input").focus();
    }
  } catch { /* clipboard denied */ }
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

document.getElementById("ctx-upload-md")?.addEventListener("click", () => {
  itemContextMenu.hidePopover();
  noteDialogParentId = contextMenuTargetId && workspaceItems[contextMenuTargetId]?.type === "folder"
    ? contextMenuTargetId : "root";
  markdownFileInput.click();
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

  if (parentId === "root") {
    batch.update(doc(db, "workspaces", activeWorkspaceId), {
      childrenIds: [...(activeWorkspace.childrenIds || []), folderId]
    });
  } else {
    const parent = workspaceItems[parentId];
    batch.update(doc(db, "workspaces", activeWorkspaceId, "items", parentId), {
      childrenIds: [...(parent?.childrenIds || []), folderId]
    });
  }

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

  if (parentId === "root") {
    batch.update(doc(db, "workspaces", activeWorkspaceId), {
      childrenIds: [...(activeWorkspace.childrenIds || []), linkId]
    });
  } else {
    const parent = workspaceItems[parentId];
    batch.update(doc(db, "workspaces", activeWorkspaceId, "items", parentId), {
      childrenIds: [...(parent?.childrenIds || []), linkId]
    });
  }

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
// NOTE DIALOG & MARKDOWN UPLOADER
// ─────────────────────────────────────────────────────────────────────

function openNoteDialog(noteId = null, parentId = "root") {
  editingNoteId = noteId;
  noteDialogParentId = parentId && workspaceItems[parentId]?.type === "folder" ? parentId : "root";

  const dialogTitle   = document.getElementById("note-dialog-title");
  const titleInput    = document.getElementById("note-title-input");
  const contentInput  = document.getElementById("note-content-input");

  if (noteId && workspaceItems[noteId]) {
    const item = workspaceItems[noteId];
    if (dialogTitle)  dialogTitle.textContent = "Edit Note";
    if (titleInput)   titleInput.value   = item.title || "";
    if (contentInput) contentInput.value = item.content || "";
  } else {
    if (dialogTitle)  dialogTitle.textContent = "New Note";
    if (titleInput)   titleInput.value   = "";
    if (contentInput) contentInput.value = "";
  }

  try { noteDialog.showModal(); } catch (err) { console.error("Note modal error:", err); }
  setTimeout(() => titleInput?.focus(), 50);
}

document.getElementById("note-cancel-btn")?.addEventListener("click", () => noteDialog.close());

const noteSaveBtn = document.getElementById("note-save-btn");

noteDialog?.querySelector("form")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const title   = document.getElementById("note-title-input").value.trim();
  const content = document.getElementById("note-content-input").value;
  if (!title) return;

  setButtonLoading(noteSaveBtn, true, "Saving Note...");

  if (editingNoteId && workspaceItems[editingNoteId]) {
    // Edit existing note
    try {
      await updateDoc(doc(db, "workspaces", activeWorkspaceId, "items", editingNoteId), {
        title,
        content
      });
      showToast("Note saved successfully!", "success");
      const updatedItem = { ...workspaceItems[editingNoteId], title, content };
      if (selectedItemId === editingNoteId) {
        showPreviewState(updatedItem);
      }
      noteDialog.close();
    } catch (err) {
      console.error("Update note failed:", err);
      showToast("Failed to save note: " + err.message, "error");
    } finally {
      setButtonLoading(noteSaveBtn, false);
    }
  } else {
    // Create new note
    try {
      const { noteId: newNoteId, noteDoc } = await createNoteItem(title, content, noteDialogParentId);
      // Optimistically add to local cache so preview works immediately (before snapshot fires)
      workspaceItems[newNoteId] = noteDoc;
      selectedItemId = newNoteId;
      showToast("Note created successfully!", "success");
      noteDialog.close();
      showPreviewState(noteDoc);
    } catch (err) {
      console.error("Create note failed:", err);
      showToast("Failed to create note: " + err.message, "error");
    } finally {
      setButtonLoading(noteSaveBtn, false);
    }
  }
});

async function createNoteItem(title, content, parentId) {
  const noteId    = generateUUID();
  const batch     = writeBatch(db);
  const sharedVia = parentId === "root" ? null : (workspaceItems[parentId]?.sharedVia || null);

  const noteDoc = {
    id: noteId,
    parentId,
    type: "note",
    title,
    content: content || "",
    createdAt: Date.now(),
    ...(sharedVia ? { sharedVia } : {})
  };

  batch.set(doc(db, "workspaces", activeWorkspaceId, "items", noteId), noteDoc);

  if (parentId === "root") {
    batch.update(doc(db, "workspaces", activeWorkspaceId), {
      childrenIds: [...(activeWorkspace.childrenIds || []), noteId]
    });
  } else {
    const parent = workspaceItems[parentId];
    batch.update(doc(db, "workspaces", activeWorkspaceId, "items", parentId), {
      childrenIds: [...(parent?.childrenIds || []), noteId]
    });
  }

  await batch.commit();
  // Return both the ID and the constructed doc so callers can optimistically
  // show the preview before the onSnapshot fires
  return { noteId, noteDoc };
}

markdownFileInput?.addEventListener("change", (e) => {
  const file = e.target.files?.[0];
  if (!file) return;

  const toast = showToast(`Uploading "${file.name}"...`, "loading", 0);

  const reader = new FileReader();
  reader.onload = async (evt) => {
    const text  = evt.target.result || "";
    const title = file.name || "Untitled Note.md";
    try {
      const { noteId: newNoteId, noteDoc } = await createNoteItem(title, text, noteDialogParentId);
      // Optimistically add to local cache so preview works immediately (before snapshot fires)
      workspaceItems[newNoteId] = noteDoc;
      selectedItemId = newNoteId;
      toast.remove();
      showToast(`Uploaded "${title}" successfully!`, "success");
      showPreviewState(noteDoc);
    } catch (err) {
      toast.remove();
      console.error("Upload markdown failed:", err);
      showToast("Failed to upload file: " + err.message, "error");
    }
    markdownFileInput.value = "";
  };
  reader.readAsText(file);
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
    propagateSharedVia(batch, folderId, folderId, true /* skip root, already done */);
  } else {
    // Delete sharedFolders entry
    batch.delete(doc(db, "sharedFolders", folderId));

    // Remove sharedVia from folder + all descendants
    batch.update(doc(db, "workspaces", activeWorkspaceId, "items", folderId), {
      sharedVia: deleteField()
    });
    propagateSharedVia(batch, folderId, null, true);
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
  document.getElementById("workspace-dialog-title").textContent = creatingSpace ? "New space" : "Space settings";
  document.getElementById("workspace-title-input").value = space?.title || "";
  document.getElementById("workspace-author-input").value = space?.authorName || "";
  document.getElementById("workspace-icon-input").value = space?.icon || "";
  document.getElementById("workspace-error").classList.add("hidden");
  selectedThemeColor = space?.themeColor || "purple";
  syncThemeColorPicker(selectedThemeColor);
  workspaceDialog.showModal();
}

document.getElementById("rename-workspace-btn").addEventListener("click", () => {
  if (activeWorkspace && !isSharedView) openWorkspaceDialog(activeWorkspace);
});
document.getElementById("new-space").addEventListener("click", () => {
  if (currentUser && !isSharedView && !savingNote) openWorkspaceDialog(null);
});

document.getElementById("workspace-cancel-btn").addEventListener("click", () => workspaceDialog.close());

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
  const icon = document.getElementById("workspace-icon-input").value.trim();
  if (!title) return;

  const saveBtn = document.getElementById("workspace-save-btn");
  if (saveBtn.disabled) return;
  const errorEl = document.getElementById("workspace-error");
  saveBtn.textContent = "Saving…";
  saveBtn.disabled    = true;
  errorEl.classList.add("hidden");

  try {
    if (creatingSpace) {
      const space = await createWorkspace(title, authorName, selectedThemeColor, icon);
      if (!spaces.some((entry) => entry.id === space.id)) spaces.push(space);
      loadWorkspace(space.id);
    } else {
      await updateDoc(doc(db, "workspaces", activeWorkspaceId), {
        title, authorName, themeColor: selectedThemeColor, icon: icon || deleteField()
      });
    }
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
          workspaceItems[linkId] = linkDoc; // Optimistic update
        }

        if (parentId === "root") {
          batch.update(doc(db, "workspaces", activeWorkspaceId), {
            childrenIds: [...(activeWorkspace.childrenIds || []), ...newLinkIds]
          });
        } else {
          const parent = workspaceItems[parentId];
          batch.update(doc(db, "workspaces", activeWorkspaceId, "items", parentId), {
            childrenIds: [...(parent?.childrenIds || []), ...newLinkIds]
          });
          // Ensure target folder is open, all others preserve collapsed state
          collapsedFolderIds.delete(parentId);
          saveCollapsedState();
        }

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
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

function getDomain(url) {
  try { return new URL(url).hostname.replace("www.", ""); } catch { return url; }
}

function isValidUrl(str) {
  try {
    const u = new URL(str);
    return (u.protocol === "http:" || u.protocol === "https:") && Boolean(u.hostname);
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
  const results = [];
  for (const token of tokens) {
    const normalized = normalizeUrl(token);
    if (normalized && !results.includes(normalized)) {
      results.push(normalized);
    }
  }
  return results;
}

// Returns true if `targetId` is a descendant of `ancestorId`
function isDescendantOf(targetId, ancestorId) {
  const target = workspaceItems[targetId];
  if (!target || !ancestorId) return false;
  if (target.parentId === ancestorId) return true;
  if (target.parentId === "root") return false;
  return isDescendantOf(target.parentId, ancestorId);
}

// Returns flat list of all descendant IDs of a folder
function getAllDescendants(folderId) {
  const result = [];
  const folder = workspaceItems[folderId];
  if (!folder?.childrenIds) return result;
  folder.childrenIds.forEach(childId => {
    result.push(childId);
    result.push(...getAllDescendants(childId));
  });
  return result;
}
