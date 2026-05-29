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

const THEMES = {
  charcoal: { primary: "#1E1E1E", primaryLight: "rgba(30,30,30,0.08)",  hover: "#2D2D2D",  bg: "#E5E5EA" },
  teal:     { primary: "#00B08B", primaryLight: "rgba(0,176,139,0.08)", hover: "#009677",  bg: "#D1F2EB" },
  blue:     { primary: "#0084C7", primaryLight: "rgba(0,132,199,0.08)", hover: "#006BA6",  bg: "#D6EAF8" },
  purple:   { primary: "#7C3AED", primaryLight: "rgba(124,58,237,0.08)",hover: "#6D28D9",  bg: "#E2DAF2" }, // Exact original lavender background
  amber:    { primary: "#D97706", primaryLight: "rgba(217,119,6,0.08)", hover: "#B45309",  bg: "#FCF3CF" },
  pink:     { primary: "#DB2777", primaryLight: "rgba(219,39,119,0.08)",hover: "#BE185D",  bg: "#FBCFE8" },
  red:      { primary: "#DC2626", primaryLight: "rgba(220,38,38,0.08)", hover: "#B91C1C",  bg: "#FDEDEC" },
  orange:   { primary: "#EA580C", primaryLight: "rgba(234,88,12,0.08)", hover: "#C2410C",  bg: "#FDEBD0" },
};

function applyTheme(name) {
  const t = THEMES[name] || THEMES.purple;
  const r = document.documentElement.style;
  r.setProperty("--color-primary",       t.primary);
  r.setProperty("--color-primary-light", t.primaryLight);
  r.setProperty("--color-primary-hover", t.hover);
  r.setProperty("--bg-app",              t.bg); // Fix: set --bg-app (used in styles.css) instead of unused --bg-main
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

// Shared-folder view
let isSharedView        = false;
let sharedRootFolderId  = null;
let sharedFolderData    = null;  // data from /sharedFolders/{id}

// Drag & drop
let draggedItemId    = null;
let currentDropTarget = null; // { id, zone: 'before'|'after'|'inside' }

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

// ─────────────────────────────────────────────────────────────────────
// AUTH + INITIAL LOAD
// ─────────────────────────────────────────────────────────────────────

onAuthStateChanged(auth, async (user) => {
  if (user) {
    currentUser = user;
    updateAccountUI();

    const urlParams = new URLSearchParams(window.location.search);
    const sharedFolderId = urlParams.get("f");

    if (sharedFolderId) {
      await loadSharedFolderView(sharedFolderId);
    } else {
      await loadUserWorkspace();
    }
  } else {
    try {
      await signInAnonymously(auth);
    } catch (err) {
      treeRoot.innerHTML = `
        <div class="loading-spinner" style="text-align:center;padding:20px">
          <span style="color:#EA4335;font-weight:600">Authentication Blocked</span>
          <span style="font-size:13px;margin-top:6px">${err.message}</span>
        </div>`;
    }
  }
});

// ─────────────────────────────────────────────────────────────────────
// WORKSPACE LOADING — OWNER
// ─────────────────────────────────────────────────────────────────────

async function loadUserWorkspace() {
  try {
    let lastId = localStorage.getItem(`lf_active_ws_${currentUser.uid}`);

    if (lastId) {
      const wsDoc = await getDoc(doc(db, "workspaces", lastId));
      if (wsDoc.exists() && wsDoc.data().ownerId === currentUser.uid) {
        loadWorkspace(lastId);
        return;
      }
    }

    // Query for any workspace owned by user
    const q = query(collection(db, "workspaces"), where("ownerId", "==", currentUser.uid));
    const snap = await getDocs(q);
    if (!snap.empty) {
      loadWorkspace(snap.docs[0].id);
      return;
    }

    // Create default workspace
    const newWsId = generateUUID();
    await setDoc(doc(db, "workspaces", newWsId), {
      id: newWsId,
      ownerId: currentUser.uid,
      title: "bookmarks",
      authorName: currentUser.displayName || "guest",
      themeColor: "purple",
      childrenIds: [],
      createdAt: serverTimestamp()
    });
    loadWorkspace(newWsId);
  } catch (err) {
    console.error("loadUserWorkspace error:", err);
  }
}

function loadWorkspace(wsId) {
  // Tear down previous listeners
  if (unsubWorkspace) unsubWorkspace();
  if (unsubItems)     unsubItems();

  isSharedView       = false;
  sharedRootFolderId = null;
  sharedFolderData   = null;
  activeWorkspaceId  = wsId;

  localStorage.setItem(`lf_active_ws_${currentUser.uid}`, wsId);

  // Live workspace doc
  unsubWorkspace = onSnapshot(doc(db, "workspaces", wsId), (snap) => {
    if (!snap.exists()) return;
    activeWorkspace = snap.data();
    applyTheme(activeWorkspace.themeColor || "purple");
    selectedThemeColor = activeWorkspace.themeColor || "purple";

    document.getElementById("workspace-title-display").textContent  = activeWorkspace.title;
    document.getElementById("workspace-author-display").textContent = `A folder from ${activeWorkspace.authorName || "guest"}`;

    syncThemeColorPicker(selectedThemeColor);
    renderTree(true);
  });

  // Live items subcollection
  unsubItems = onSnapshot(collection(db, "workspaces", wsId, "items"), (snap) => {
    workspaceItems = {};
    snap.forEach(d => { workspaceItems[d.id] = d.data(); });
    renderTree(true);
  });

  document.getElementById("add-folder-btn")?.classList.remove("hidden");
  document.getElementById("rename-workspace-btn").classList.remove("hidden");
}

// ─────────────────────────────────────────────────────────────────────
// SHARED FOLDER VIEW — VISITOR
// ─────────────────────────────────────────────────────────────────────

async function loadSharedFolderView(folderId) {
  if (unsubWorkspace) unsubWorkspace();
  if (unsubItems)     unsubItems();

  isSharedView       = true;
  sharedRootFolderId = folderId;
  workspaceItems     = {};

  treeRoot.innerHTML = `<div class="loading-spinner"><div class="spinner"></div><span>Loading shared folder…</span></div>`;

  const shareSnap = await getDoc(doc(db, "sharedFolders", folderId));
  if (!shareSnap.exists()) {
    treeRoot.innerHTML = `<div class="loading-spinner"><span>⚠️ This share link is no longer active.</span></div>`;
    return;
  }

  sharedFolderData  = shareSnap.data();
  const workspaceId = sharedFolderData.workspaceId;
  activeWorkspaceId = workspaceId;

  applyTheme(sharedFolderData.themeColor || "purple");
  document.getElementById("workspace-title-display").textContent  = sharedFolderData.folderTitle;
  document.getElementById("workspace-author-display").textContent = `Shared by ${sharedFolderData.authorName || "someone"}`;

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
        <span>Clone this folder to my workspace</span>
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
  selectedItemId = null;

  if (isSharedView) {
    const rootFolder = workspaceItems[sharedRootFolderId];
    if (!rootFolder) return;

    (rootFolder.childrenIds || []).forEach(childId => {
      const child = workspaceItems[childId];
      if (child) treeRoot.appendChild(renderNode(child, 0, false));
    });

    if ((rootFolder.childrenIds || []).length === 0) {
      showEmptyState(rootFolder.title, "This shared folder is empty.");
    }
    return;
  }

  if (!activeWorkspace) return;

  const rootIds = activeWorkspace.childrenIds || [];
  if (rootIds.length === 0) {
    showEmptyState("Welcome to Plop", "Right-click the sidebar to create a folder, or paste a link with Cmd/Ctrl+V.");
    return;
  }

  rootIds.forEach(itemId => {
    const item = workspaceItems[itemId];
    if (item && item.parentId === "root") {
      treeRoot.appendChild(renderNode(item, 0, true));
    }
  });

  emptyState.classList.add("hidden");
  previewState.classList.add("hidden");
}

function renderNode(item, depth, isOwner) {
  const isFolder = item.type === "folder";
  const isExpanded = item._expanded !== false; // default open

  const el = document.createElement("div");
  el.className = "tree-item";
  el.dataset.id   = item.id;
  el.dataset.type = item.type;
  el.draggable    = isOwner;
  el.style.paddingLeft = `${depth * 14 + 10}px`; // Increased depth spacing for better readability

  // ── Toggle arrow (folders only) ──
  const toggleEl = document.createElement("span");
  if (isFolder) {
    toggleEl.className = `folder-toggle${isExpanded ? "" : " collapsed"}`;
    toggleEl.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg>`;
    toggleEl.addEventListener("click", (e) => {
      e.stopPropagation();
      const childCont = el.nextElementSibling;
      const collapsed = toggleEl.classList.toggle("collapsed");
      if (childCont?.classList.contains("folder-children")) {
        childCont.style.display = collapsed ? "none" : "";
      }
    });
  } else {
    toggleEl.className = "folder-toggle-spacer";
  }

  // ── Icon ──
  const iconEl = document.createElement("span");
  if (isFolder) {
    iconEl.className = "folder-icon";
    iconEl.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" fill="currentColor" fill-opacity="0.15"/><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>`;
  } else {
    iconEl.className = "link-favicon-wrap";
    const faviconEl = document.createElement("img");
    faviconEl.className = "link-favicon";
    faviconEl.src = `https://www.google.com/s2/favicons?domain=${getDomain(item.url)}&sz=32`;
    faviconEl.onerror = () => { faviconEl.src = ""; faviconEl.style.display = "none"; };
    iconEl.appendChild(faviconEl);
  }

  // ── Title ──
  const titleEl = document.createElement("span");
  titleEl.className    = "tree-item-title";
  titleEl.textContent  = item.title;

  // ── Content container (aligns toggle, icon, title) ──
  const contentEl = document.createElement("div");
  contentEl.className = "tree-item-content";
  contentEl.appendChild(toggleEl);
  contentEl.appendChild(iconEl);
  contentEl.appendChild(titleEl);
  el.appendChild(contentEl);

  // ── Actions (3-dot button) ──
  if (isOwner) {
    const actionsEl = document.createElement("div");
    actionsEl.className = "tree-item-actions";

    const optBtn = document.createElement("button");
    optBtn.className  = "item-btn";
    optBtn.title      = "Options";
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
// UI HELPERS
// ─────────────────────────────────────────────────────────────────────

function showEmptyState(title, desc) {
  document.getElementById("empty-title").textContent = title;
  document.getElementById("empty-desc").textContent  = desc;
  emptyState.classList.remove("hidden");
  previewState.classList.add("hidden");
}

function showPreviewState(item) {
  activeFavicon.src  = `https://www.google.com/s2/favicons?domain=${getDomain(item.url)}&sz=32`;
  activeTitle.textContent = item.title;
  activeUrl.textContent   = item.url;
  activeLinkOpen.href     = item.url;
  if (activeLinkOpenWarn) activeLinkOpenWarn.href = item.url;

  emptyState.classList.add("hidden");
  previewState.classList.remove("hidden");

  previewIframe.src = item.url;
  if (iframeBlockedWarn) iframeBlockedWarn.classList.add("hidden");
  previewIframe.onload = () => {
    try {
      if (previewIframe.contentDocument) iframeBlockedWarn?.classList.add("hidden");
    } catch {
      iframeBlockedWarn?.classList.remove("hidden");
    }
  };
}

document.getElementById("preview-back-btn")?.addEventListener("click", () => {
  previewIframe.src = "";
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

  // Visibility of menu items based on item type
  document.getElementById("ctx-add-link").classList.toggle("hidden",    !isFolder);
  document.getElementById("ctx-add-subfolder").classList.toggle("hidden", !isFolder);
  document.getElementById("ctx-share").classList.toggle("hidden",        !isFolder);
  document.getElementById("ctx-copy-link").classList.toggle("hidden",    isFolder);

  // Label: "Rename" for folders, "Edit" for links
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
  if (e.target.closest(".tree-item")) return;
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

document.getElementById("ctx-add-link").addEventListener("click", () => {
  itemContextMenu.hidePopover();
  linkDialogParentId = contextMenuTargetId;
  document.getElementById("link-url-input").value   = "";
  document.getElementById("link-title-input").value = "";
  document.getElementById("link-dialog-title").textContent = `Add Link in ${workspaceItems[contextMenuTargetId]?.title || "folder"}`;
  linkDialog.showModal();
  setTimeout(() => document.getElementById("link-url-input").focus(), 50);
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

document.getElementById("ctx-copy-link").addEventListener("click", () => {
  itemContextMenu.hidePopover();
  const item = workspaceItems[contextMenuTargetId];
  if (item?.url) {
    navigator.clipboard.writeText(item.url).catch(() => {});
  }
});

document.getElementById("ctx-rename").addEventListener("click", () => {
  itemContextMenu.hidePopover();
  openEditDialog(contextMenuTargetId);
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

folderDialog.querySelector("form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const title = document.getElementById("folder-title-input").value.trim();
  if (!title) return;

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
    folderDialog.close();
  } catch (err) {
    console.error("Create folder failed:", err);
  }
});

// ─────────────────────────────────────────────────────────────────────
// LINK DIALOG
// ─────────────────────────────────────────────────────────────────────

document.getElementById("link-cancel-btn").addEventListener("click", () => linkDialog.close());

linkDialog.querySelector("form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const url   = document.getElementById("link-url-input").value.trim();
  const title = document.getElementById("link-title-input").value.trim() || getDomain(url);
  if (!url) return;

  const linkId   = generateUUID();
  const parentId = linkDialogParentId;
  const batch    = writeBatch(db);

  const sharedVia = parentId === "root" ? null : (workspaceItems[parentId]?.sharedVia || null);

  const linkDoc = {
    id: linkId,
    parentId,
    type: "link",
    title,
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

  try {
    await batch.commit();
    linkDialog.close();
  } catch (err) {
    console.error("Create link failed:", err);
  }
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

editItemDialog.querySelector("form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const item  = workspaceItems[contextMenuTargetId];
  if (!item) { editItemDialog.close(); return; }

  const newTitle = document.getElementById("edit-item-title-input").value.trim();
  const newUrl   = document.getElementById("edit-item-url-input").value.trim();
  if (!newTitle) return;

  const updates = { title: newTitle };
  if (item.type === "link" && newUrl) updates.url = newUrl;

  try {
    await updateDoc(doc(db, "workspaces", activeWorkspaceId, "items", contextMenuTargetId), updates);
    editItemDialog.close();
  } catch (err) {
    console.error("Edit failed:", err);
  }
});

// ─────────────────────────────────────────────────────────────────────
// DELETE CONFIRM
// ─────────────────────────────────────────────────────────────────────

document.getElementById("delete-confirm-cancel-btn").addEventListener("click", () => deleteConfirmDialog.close());

document.getElementById("delete-confirm-btn").addEventListener("click", async () => {
  const targetId = contextMenuTargetId;
  const item = workspaceItems[targetId];
  if (!item) { deleteConfirmDialog.close(); return; }

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
    deleteConfirmDialog.close();
    if (selectedItemId === targetId || toDelete.includes(selectedItemId)) {
      selectedItemId = null;
      showEmptyState("Welcome to Plop", "Select a folder or link from the sidebar.");
    }
  } catch (err) {
    console.error("Delete failed:", err);
    alert(`Delete failed: ${err.message}`);
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
// WORKSPACE SETTINGS DIALOG
// ─────────────────────────────────────────────────────────────────────

document.getElementById("rename-workspace-btn").addEventListener("click", () => {
  if (!activeWorkspace) return;
  document.getElementById("workspace-title-input").value  = activeWorkspace.title || "";
  document.getElementById("workspace-author-input").value = activeWorkspace.authorName || "";
  selectedThemeColor = activeWorkspace.themeColor || "purple";
  syncThemeColorPicker(selectedThemeColor);
  workspaceDialog.showModal();
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
    d.classList.toggle("active", d.dataset.color === color);
  });
}

document.getElementById("workspace-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!activeWorkspaceId) return;

  const title      = document.getElementById("workspace-title-input").value.trim();
  const authorName = document.getElementById("workspace-author-input").value.trim() ||
                     activeWorkspace?.authorName || "guest";
  if (!title) return;

  const saveBtn = document.getElementById("workspace-save-btn");
  const errorEl = document.getElementById("workspace-error");
  saveBtn.textContent = "Saving…";
  saveBtn.disabled    = true;
  errorEl.classList.add("hidden");

  try {
    await updateDoc(doc(db, "workspaces", activeWorkspaceId), {
      title,
      authorName,
      themeColor: selectedThemeColor
    });
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
  if (unsubWorkspace) unsubWorkspace();
  if (unsubItems)     unsubItems();
  activeWorkspaceId = null;
  activeWorkspace   = null;
  workspaceItems    = {};
  treeRoot.innerHTML = "";
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
    if (!text || !isValidUrl(text)) return;

    const parentId = selectedItemId && workspaceItems[selectedItemId]?.type === "folder"
      ? selectedItemId : "root";

    linkDialogParentId = parentId;
    document.getElementById("link-url-input").value   = text;
    document.getElementById("link-title-input").value = "";
    const parentName = parentId === "root" ? "workspace" : (workspaceItems[parentId]?.title || "folder");
    document.getElementById("link-dialog-title").textContent = `Add Link in ${parentName}`;
    linkDialog.showModal();
    setTimeout(() => document.getElementById("link-title-input").focus(), 50);
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
  try { const u = new URL(str); return u.protocol === "http:" || u.protocol === "https:"; }
  catch { return false; }
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
