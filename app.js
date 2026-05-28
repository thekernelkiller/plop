import { 
  signInAnonymously, 
  onAuthStateChanged, 
  signInWithPopup, 
  GoogleAuthProvider, 
  linkWithCredential,
  linkWithPopup,
  signOut 
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { 
  doc, 
  collection, 
  query, 
  where, 
  getDoc,
  getDocs,
  setDoc, 
  updateDoc, 
  addDoc, 
  deleteDoc, 
  onSnapshot, 
  writeBatch,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { auth, db } from "./firebase-config.js";

window.firebaseAuth = auth;
window.firebaseDb = db;

// Global App State
let currentUser = null;
let activeWorkspaceId = null;
let activeWorkspace = null;
let workspaceItems = {}; // Map of itemId -> itemDoc
let unsubWorkspace = null;
let unsubItems = null;

let selectedItemId = null; // Currently highlighted item in sidebar
let contextMenuTargetId = null; // Item ID target of the context menu
let linkDialogParentId = "root"; // Parent ID target for the link creation modal

// DOM Elements
const treeRoot = document.getElementById("tree-root");
const emptyState = document.getElementById("empty-state");
const previewState = document.getElementById("preview-state");
const activeFavicon = document.getElementById("active-favicon");
const activeTitle = document.getElementById("active-title");
const activeUrl = document.getElementById("active-url");
const activeLinkOpen = document.getElementById("active-link-open");
const activeLinkOpenWarning = document.getElementById("active-link-open-warning");
const previewIframe = document.getElementById("preview-iframe");
const iframeBlockedWarning = document.getElementById("iframe-blocked-warning");
const appContainer = document.querySelector(".app-container");

// Dialogs
const linkDialog = document.getElementById("link-dialog");
const folderDialog = document.getElementById("folder-dialog");
const workspaceDialog = document.getElementById("workspace-dialog");
const shareDialog = document.getElementById("share-dialog");
const accountDialog = document.getElementById("account-dialog");

// Context Menu
const contextMenu = document.getElementById("item-context-menu");

// Initialize Auth
onAuthStateChanged(auth, async (user) => {
  if (user) {
    currentUser = user;
    console.log("Logged in user UID:", user.uid);
    updateAccountUI();
    
    // Check url search parameters for shared workspace first
    const urlParams = new URLSearchParams(window.location.search);
    const shareId = urlParams.get("share");
    
    if (shareId) {
      // Load shared workspace (will check ownership once document snapshot arrives)
      loadWorkspace(shareId);
    } else {
      // Find or create user's active workspace
      await loadUserWorkspace();
    }
  } else {
    // Zero-friction sign-in anonymously
    console.log("Starting anonymous auth sign-in...");
    try {
      await signInAnonymously(auth);
    } catch (error) {
      console.error("Anonymous authentication error:", error);
      document.getElementById("tree-root").innerHTML = `
        <div class="loading-spinner" style="text-align: center; padding: 20px;">
          <span style="color: #EA4335; font-weight: 600; font-size: 16px;">Authentication Blocked</span>
          <span style="font-size: 13px; margin-top: 6px;">Guest authentication failed: ${error.message}</span>
          <span style="font-size: 11px; margin-top: 12px; opacity: 0.8; line-height: 1.4;">Please verify that <strong>Anonymous provider</strong> is enabled in your Firebase Console under Authentication > Sign-in method.</span>
        </div>
      `;
    }
  }
});

// Load user's private workspace
async function loadUserWorkspace() {
  try {
    // Check local storage for last active workspace ID
    let lastId = localStorage.getItem(`lf_active_ws_${currentUser.uid}`);
    
    if (lastId) {
      // Verify workspace exists and belongs to user
      const wsDoc = await getDoc(doc(db, "workspaces", lastId));
      if (wsDoc.exists() && wsDoc.data().ownerId === currentUser.uid) {
        loadWorkspace(lastId);
        return;
      }
    }
    
    // Fetch user's workspaces from Firestore
    const q = query(collection(db, "workspaces"), where("ownerId", "==", currentUser.uid));
    const querySnapshot = await getDocs(q);
    
    if (!querySnapshot.empty) {
      const firstWs = querySnapshot.docs[0].id;
      loadWorkspace(firstWs);
    } else {
      // Create first default workspace
      const newWsId = generateUUID();
      const wsData = {
        id: newWsId,
        ownerId: currentUser.uid,
        title: "bookmarks",
        authorName: currentUser.displayName || "guest",
        sharing: "private",
        childrenIds: [], // Root item ordering list
        createdAt: serverTimestamp()
      };
      
      await setDoc(doc(db, "workspaces", newWsId), wsData);
      
      // Add default bookmarks folder
      const defaultFolderId = generateUUID();
      await setDoc(doc(db, "workspaces", newWsId, "items", defaultFolderId), {
        id: defaultFolderId,
        parentId: "root",
        type: "folder",
        title: "testing stuff",
        childrenIds: [],
        createdAt: Date.now()
      });
      
      // Update root childrenIds in workspace
      await updateDoc(doc(db, "workspaces", newWsId), {
        childrenIds: [defaultFolderId]
      });
      
      loadWorkspace(newWsId);
    }
  } catch (error) {
    console.error("Error loading user workspaces:", error);
    document.getElementById("tree-root").innerHTML = `
      <div class="loading-spinner" style="text-align: center; padding: 20px;">
        <span style="color: #EA4335; font-weight: 600; font-size: 16px;">Firestore Access Blocked</span>
        <span style="font-size: 13px; margin-top: 6px; word-break: break-word;">${error.message}</span>
        <span style="font-size: 11px; margin-top: 12px; opacity: 0.8; line-height: 1.4;">Please ensure you have copied the rules from <code>firestore.rules</code> and published them in the Firebase Console (Firestore > Rules).</span>
      </div>
    `;
  }
}

// Load a specific workspace
function loadWorkspace(workspaceId) {
  // Clear any existing subscriptions
  if (unsubWorkspace) unsubWorkspace();
  if (unsubItems) unsubItems();
  
  activeWorkspaceId = workspaceId;

  // Subscribe to Workspace Document changes
  unsubWorkspace = onSnapshot(
    doc(db, "workspaces", workspaceId), 
    (docSnap) => {
      if (docSnap.exists()) {
        activeWorkspace = docSnap.data();
        
        // Smart Authorization: Enable edit capability if current visitor is the creator
        const isOwner = activeWorkspace.ownerId === currentUser.uid;
        
        // Automatically upgrade "guest" author name if user is now authenticated with Google
        if (isOwner && !currentUser.isAnonymous && currentUser.displayName && activeWorkspace.authorName === "guest") {
          activeWorkspace.authorName = currentUser.displayName; // Update local value to prevent UI flash
          updateDoc(doc(db, "workspaces", workspaceId), {
            authorName: currentUser.displayName
          }).catch(err => console.error("Error updating author name:", err));
        }
        
        // Update workspace meta display
        document.getElementById("workspace-title-display").textContent = activeWorkspace.title;
        document.getElementById("workspace-author-display").textContent = `A Folder from ${activeWorkspace.authorName || 'guest'}`;
        
        if (isOwner) {
          localStorage.setItem(`lf_active_ws_${currentUser.uid}`, workspaceId);
        }
        
        // Update banner and operations toolbar permissions
        updateSidebarFooterUI(isOwner);

        // Update share settings state
        document.getElementById("share-toggle").checked = activeWorkspace.sharing === "public";
        document.getElementById("share-link-input").value = `${window.location.origin}${window.location.pathname}?share=${activeWorkspace.id}`;
        if (activeWorkspace.sharing === "public") {
          document.getElementById("share-link-section").classList.remove("hidden");
        } else {
          document.getElementById("share-link-section").classList.add("hidden");
        }

        // Re-render items whenever activeWorkspace root ordering updates
        renderTree(isOwner);
      } else {
        console.warn("Workspace not found!");
        showEmptyState("Workspace Not Found", "This workspace is private or does not exist. If you are the owner, please sign in.");
        document.getElementById("tree-root").innerHTML = `
          <div class="loading-spinner">
            <span>Workspace Not Found</span>
          </div>
        `;
      }
    },
    (error) => {
      console.error("Workspace snapshot error:", error);
      showEmptyState("Access Denied", "This workspace is private or does not exist. If you are the owner, please sign in.");
      document.getElementById("tree-root").innerHTML = `
        <div class="loading-spinner">
          <span>Access Denied or Private Folder</span>
        </div>
      `;
    }
  );

  // Subscribe to Items Subcollection changes
  unsubItems = onSnapshot(
    collection(db, "workspaces", workspaceId, "items"), 
    (querySnapshot) => {
      workspaceItems = {};
      querySnapshot.forEach((docSnap) => {
        workspaceItems[docSnap.id] = docSnap.data();
      });
      
      if (activeWorkspace) {
        const isOwner = activeWorkspace.ownerId === currentUser.uid;
        renderTree(isOwner);
      }
    },
    (error) => {
      console.error("Items snapshot error:", error);
    }
  );
}

// Render Folder Tree
function renderTree(isOwner) {
  treeRoot.innerHTML = "";
  
  if (!activeWorkspace) return;

  const rootChildrenIds = activeWorkspace.childrenIds || [];
  const renderedIds = new Set();
  
  // Render root level items in parent workspace ordered list
  rootChildrenIds.forEach(itemId => {
    const item = workspaceItems[itemId];
    if (item && item.parentId === "root") {
      const nodeEl = renderNode(item, 0, isOwner);
      treeRoot.appendChild(nodeEl);
      renderedIds.add(itemId);
    }
  });

  // Fallback: Render root items that exist in DB but aren't in parent childrenIds array
  Object.values(workspaceItems).forEach(item => {
    if (item.parentId === "root" && !renderedIds.has(item.id)) {
      const nodeEl = renderNode(item, 0, isOwner);
      treeRoot.appendChild(nodeEl);
      renderedIds.add(item.id);
    }
  });

  if (renderedIds.size === 0) {
    treeRoot.innerHTML = `
      <div class="loading-spinner">
        <span>No folders yet. Click 'New Folder' below!</span>
      </div>
    `;
  }
}

function renderNode(item, depth, isOwner) {
  const container = document.createElement("div");
  container.className = "tree-node-container";
  container.dataset.id = item.id;
  
  const itemEl = document.createElement("div");
  itemEl.className = "tree-item";
  itemEl.dataset.id = item.id;
  if (selectedItemId === item.id) {
    itemEl.classList.add("selected");
  }
  
  // Drag and drop permissions
  if (isOwner) {
    itemEl.draggable = true;
    setupDragAndDropEvents(itemEl);
  }

  const content = document.createElement("div");
  content.className = "tree-item-content";
  
  if (item.type === "folder") {
    // Folder Expand/Collapse state from local cache
    const isCollapsed = localStorage.getItem(`lf_folder_${item.id}`) === "collapsed";
    
    const toggle = document.createElement("span");
    toggle.className = `folder-toggle ${isCollapsed ? 'collapsed' : ''}`;
    toggle.innerHTML = `
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
        <polyline points="6 9 12 15 18 9"/>
      </svg>
    `;
    toggle.addEventListener("click", (e) => {
      e.stopPropagation();
      const coll = toggle.classList.toggle("collapsed");
      localStorage.setItem(`lf_folder_${item.id}`, coll ? "collapsed" : "expanded");
      const childrenContainer = container.querySelector(".folder-children");
      if (childrenContainer) {
        childrenContainer.classList.toggle("hidden", coll);
      }
    });
    content.appendChild(toggle);

    const icon = document.createElement("span");
    icon.className = "folder-icon";
    icon.innerHTML = `
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M3 7C3 5.89543 3.89543 5 5 5H10L12 7H19C20.1046 7 21 7.89543 21 9V17C21 18.1046 20.1046 19 19 19H5C3.89543 19 3 18.1046 3 17V7Z" fill="currentColor" fill-opacity="0.15" stroke="currentColor" stroke-width="2"/>
      </svg>
    `;
    content.appendChild(icon);
  } else {
    // Spacer for toggle alignment (Arc-style vertical icon alignment)
    const spacer = document.createElement("span");
    spacer.className = "folder-toggle-spacer";
    content.appendChild(spacer);

    // Link type - fetch favicon
    const favicon = document.createElement("img");
    favicon.className = "link-favicon";
    favicon.src = `https://www.google.com/s2/favicons?domain=${getDomain(item.url)}&sz=32`;
    favicon.alt = "";
    favicon.onerror = () => {
      // Fallback favicon
      favicon.src = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' fill='%237E7A99'%3E%3Crect width='16' height='16' rx='3'/%3E%3C/svg%3E";
    };
    content.appendChild(favicon);
  }

  const title = document.createElement("span");
  title.className = "tree-item-title";
  title.textContent = item.title || item.url || "Untitled";
  content.appendChild(title);
  
  itemEl.appendChild(content);

  // Options context trigger button
  const actions = document.createElement("div");
  actions.className = "tree-item-actions";
  
  if (isOwner) {
    const optBtn = document.createElement("button");
    optBtn.className = "item-btn";
    optBtn.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
        <circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>
      </svg>
    `;
    optBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      showContextMenu(item.id, e.clientX, e.clientY);
    });
    actions.appendChild(optBtn);
  }
  
  itemEl.appendChild(actions);
  container.appendChild(itemEl);

  // Click handler to select and preview link
  itemEl.addEventListener("click", () => {
    selectTreeItem(item);
  });

  // Render children recursively if folder
  if (item.type === "folder") {
    const isCollapsed = localStorage.getItem(`lf_folder_${item.id}`) === "collapsed";
    const childrenContainer = document.createElement("div");
    childrenContainer.className = `folder-children ${isCollapsed ? 'hidden' : ''}`;
    
    // Read children IDs array
    const childIds = item.childrenIds || [];
    const renderedChildIds = new Set();
    
    childIds.forEach(childId => {
      const childDoc = workspaceItems[childId];
      if (childDoc && childDoc.parentId === item.id) {
        const childNode = renderNode(childDoc, depth + 1, isOwner);
        childrenContainer.appendChild(childNode);
        renderedChildIds.add(childId);
      }
    });

    // Fallback: If childrenIds misses an item that says its parent is this folder, render it
    Object.values(workspaceItems).forEach(otherItem => {
      if (otherItem.parentId === item.id && !renderedChildIds.has(otherItem.id)) {
        const childNode = renderNode(otherItem, depth + 1, isOwner);
        childrenContainer.appendChild(childNode);
        renderedChildIds.add(otherItem.id);
      }
    });

    container.appendChild(childrenContainer);
  }

  return container;
}

// Item selection and iframe preview rendering
function selectTreeItem(item) {
  // Unselect previous
  document.querySelectorAll(".tree-item").forEach(el => el.classList.remove("selected"));
  
  selectedItemId = item.id;
  const activeEl = document.querySelector(`.tree-item[data-id="${item.id}"]`);
  if (activeEl) activeEl.classList.add("selected");

  if (item.type === "folder") {
    showEmptyState(item.title, `Folder with ${item.childrenIds?.length || 0} items inside.`);
  } else {
    showPreviewState(item);
  }
  
  // Mobile responsive layout active state trigger
  appContainer.classList.add("preview-active");
}

function showEmptyState(title, desc) {
  emptyState.classList.remove("hidden");
  previewState.classList.add("hidden");
  
  document.getElementById("empty-title").textContent = title;
  document.getElementById("empty-desc").textContent = desc;
}

function showPreviewState(item) {
  emptyState.classList.add("hidden");
  previewState.classList.remove("hidden");
  
  activeFavicon.src = `https://www.google.com/s2/favicons?domain=${getDomain(item.url)}&sz=32`;
  activeTitle.textContent = item.title || item.url;
  activeUrl.textContent = item.url;
  
  activeLinkOpen.href = item.url;
  activeLinkOpenWarning.href = item.url;
  
  // Hide previous warnings
  iframeBlockedWarning.classList.add("hidden");
  previewIframe.classList.remove("hidden");
  
  // Load URL
  previewIframe.src = item.url;
  
  // Verify embedding blockers (Google, StackOverflow, etc.)
  const domain = getDomain(item.url).toLowerCase();
  const knownBlockers = ["google.com", "github.com", "twitter.com", "youtube.com", "facebook.com", "instagram.com", "apple.com", "figma.com", "stackoverflow.com", "linkedin.com", "snyk.io"];
  
  const isBlocked = knownBlockers.some(blocked => domain.includes(blocked));
  if (isBlocked) {
    previewIframe.classList.add("hidden");
    iframeBlockedWarning.classList.remove("hidden");
  }
}

// Mobile view navigation drawer back button click handler
document.getElementById("preview-back-btn").addEventListener("click", () => {
  appContainer.classList.remove("preview-active");
  // Unselect active selected link
  document.querySelectorAll(".tree-item").forEach(el => el.classList.remove("selected"));
  selectedItemId = null;
});

// Drag & Drop Controller Logic
let draggedItemId = null;

function setupDragAndDropEvents(itemEl) {
  itemEl.addEventListener("dragstart", (e) => {
    draggedItemId = itemEl.dataset.id;
    itemEl.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", draggedItemId);
  });

  itemEl.addEventListener("dragend", () => {
    itemEl.classList.remove("dragging");
    draggedItemId = null;
    document.querySelectorAll(".tree-item").forEach(el => {
      el.classList.remove("drag-over", "drag-over-inside");
    });
  });

  itemEl.addEventListener("dragover", (e) => {
    e.preventDefault();
    if (!draggedItemId || draggedItemId === itemEl.dataset.id) return;

    // Prevent dragging folder into itself
    if (isDescendantOf(draggedItemId, itemEl.dataset.id)) {
      return;
    }

    const rect = itemEl.getBoundingClientRect();
    const relativeY = e.clientY - rect.top;
    
    // Remove previous states
    itemEl.classList.remove("drag-over", "drag-over-inside");

    const dragTarget = workspaceItems[itemEl.dataset.id];

    if (dragTarget.type === "folder" && relativeY > rect.height * 0.15 && relativeY < rect.height * 0.85) {
      // Dragging inside folder
      itemEl.classList.add("drag-over-inside");
      e.dataTransfer.dropEffect = "copy";
    } else {
      // Dragging after/before item
      itemEl.classList.add("drag-over");
      e.dataTransfer.dropEffect = "move";
    }
  });

  itemEl.addEventListener("dragleave", () => {
    itemEl.classList.remove("drag-over", "drag-over-inside");
  });

  itemEl.addEventListener("drop", async (e) => {
    e.preventDefault();
    const sourceId = e.dataTransfer.getData("text/plain");
    const targetId = itemEl.dataset.id;
    
    if (!sourceId || sourceId === targetId) return;

    itemEl.classList.remove("drag-over", "drag-over-inside");
    
    const rect = itemEl.getBoundingClientRect();
    const relativeY = e.clientY - rect.top;
    
    const targetItem = workspaceItems[targetId];
    const sourceItem = workspaceItems[sourceId];
    const oldParentId = sourceItem.parentId;
    
    const batch = writeBatch(db);
    
    // 1. Remove sourceId from old parent's childrenIds array
    if (oldParentId === "root") {
      const filteredRoot = (activeWorkspace.childrenIds || []).filter(id => id !== sourceId);
      batch.update(doc(db, "workspaces", activeWorkspaceId), {
        childrenIds: filteredRoot
      });
    } else {
      const oldParentDoc = workspaceItems[oldParentId];
      if (oldParentDoc) {
        const filteredChildren = (oldParentDoc.childrenIds || []).filter(id => id !== sourceId);
        batch.update(doc(db, "workspaces", activeWorkspaceId, "items", oldParentId), {
          childrenIds: filteredChildren
        });
      }
    }

    // 2. Process Drop inside target folder
    if (targetItem.type === "folder" && relativeY > rect.height * 0.15 && relativeY < rect.height * 0.85) {
      // Set parentId of source to targetFolder ID
      batch.update(doc(db, "workspaces", activeWorkspaceId, "items", sourceId), {
        parentId: targetId
      });
      
      // Append to target folder's childrenIds list
      const newChildrenList = [...(targetItem.childrenIds || []), sourceId];
      batch.update(doc(db, "workspaces", activeWorkspaceId, "items", targetId), {
        childrenIds: newChildrenList
      });
    } else {
      // 3. Process Drop before/after target item
      const newParentId = targetItem.parentId;
      
      // Set parentId of source to target item's parentId
      batch.update(doc(db, "workspaces", activeWorkspaceId, "items", sourceId), {
        parentId: newParentId
      });
      
      if (newParentId === "root") {
        let rootChildren = [...(activeWorkspace.childrenIds || []).filter(id => id !== sourceId)];
        const targetIndex = rootChildren.indexOf(targetId);
        
        if (relativeY > rect.height * 0.5) {
          rootChildren.splice(targetIndex + 1, 0, sourceId);
        } else {
          rootChildren.splice(targetIndex, 0, sourceId);
        }
        
        batch.update(doc(db, "workspaces", activeWorkspaceId), {
          childrenIds: rootChildren
        });
      } else {
        const parentDoc = workspaceItems[newParentId];
        if (parentDoc) {
          let folderChildrenList = [...(parentDoc.childrenIds || []).filter(id => id !== sourceId)];
          const targetIndex = folderChildrenList.indexOf(targetId);
          
          if (relativeY > rect.height * 0.5) {
            folderChildrenList.splice(targetIndex + 1, 0, sourceId);
          } else {
            folderChildrenList.splice(targetIndex, 0, sourceId);
          }
          
          batch.update(doc(db, "workspaces", activeWorkspaceId, "items", newParentId), {
            childrenIds: folderChildrenList
          });
        }
      }
    }
    
    try {
      await batch.commit();
    } catch (err) {
      console.error("Batch drag-and-drop commit failed:", err);
    }
  });
}

// Dialog popup trigger handlers
document.getElementById("add-folder-btn").addEventListener("click", () => {
  if (!activeWorkspaceId) return;
  document.getElementById("folder-dialog-title").textContent = "New Folder";
  document.getElementById("folder-title-input").value = "";
  folderDialog.showModal();
});

document.getElementById("add-link-btn").addEventListener("click", () => {
  if (!activeWorkspaceId) return;
  linkDialogParentId = "root"; // Reset to root level
  document.getElementById("link-dialog-title").textContent = "Add Link";
  document.getElementById("link-url-input").value = "";
  document.getElementById("link-title-input").value = "";
  linkDialog.showModal();
});

document.getElementById("rename-workspace-btn").addEventListener("click", () => {
  if (!activeWorkspace) return;
  document.getElementById("workspace-title-input").value = activeWorkspace.title;
  document.getElementById("workspace-author-input").value = activeWorkspace.authorName || "";
  workspaceDialog.showModal();
});

document.getElementById("share-settings-btn").addEventListener("click", () => {
  shareDialog.showModal();
});

document.getElementById("account-btn").addEventListener("click", () => {
  accountDialog.showModal();
});

// Dialog Cancel actions
document.getElementById("folder-cancel-btn").addEventListener("click", () => folderDialog.close());
document.getElementById("link-cancel-btn").addEventListener("click", () => linkDialog.close());
document.getElementById("workspace-cancel-btn").addEventListener("click", () => workspaceDialog.close());
document.getElementById("share-close-btn").addEventListener("click", () => shareDialog.close());
document.getElementById("account-close-btn-1").addEventListener("click", () => accountDialog.close());
document.getElementById("account-close-btn-2").addEventListener("click", () => accountDialog.close());

// Add Folder Submit Action
folderDialog.querySelector("form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const folderTitle = document.getElementById("folder-title-input").value.trim();
  if (!folderTitle) return;
  
  try {
    const folderId = generateUUID();
    const folderDoc = {
      id: folderId,
      parentId: "root",
      type: "folder",
      title: folderTitle,
      childrenIds: [],
      createdAt: Date.now()
    };
    
    const batch = writeBatch(db);
    batch.set(doc(db, "workspaces", activeWorkspaceId, "items", folderId), folderDoc);
    
    // Add to workspace root childrenIds list
    const currentRootChildren = [...(activeWorkspace.childrenIds || []), folderId];
    batch.update(doc(db, "workspaces", activeWorkspaceId), {
      childrenIds: currentRootChildren
    });
    
    await batch.commit();
    folderDialog.close();
  } catch (error) {
    console.error("Create folder error:", error);
  }
});

// Add Link Submit Action
linkDialog.querySelector("form").addEventListener("submit", async (e) => {
  e.preventDefault();
  let url = document.getElementById("link-url-input").value.trim();
  let title = document.getElementById("link-title-input").value.trim();
  
  if (!url) return;
  
  // Automatically prepend protocol if missing to prevent Firestore security rules rejection
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    url = "https://" + url;
  }
  
  if (!title) {
    title = getDomain(url);
  }
  
  try {
    const linkId = generateUUID();
    const linkDoc = {
      id: linkId,
      parentId: linkDialogParentId,
      type: "link",
      title: title,
      url: url,
      createdAt: Date.now()
    };
    
    const batch = writeBatch(db);
    batch.set(doc(db, "workspaces", activeWorkspaceId, "items", linkId), linkDoc);
    
    // Add to parent childrenIds list
    if (linkDialogParentId === "root") {
      const currentRootChildren = [...(activeWorkspace.childrenIds || []), linkId];
      batch.update(doc(db, "workspaces", activeWorkspaceId), {
        childrenIds: currentRootChildren
      });
    } else {
      const parentFolder = workspaceItems[linkDialogParentId];
      if (parentFolder) {
        const currentFolderChildren = [...(parentFolder.childrenIds || []), linkId];
        batch.update(doc(db, "workspaces", activeWorkspaceId, "items", linkDialogParentId), {
          childrenIds: currentFolderChildren
        });
      }
    }
    
    await batch.commit();
    linkDialog.close();
  } catch (error) {
    console.error("Create link error:", error);
    alert(`Failed to save link: ${error.message}. Please make sure you have permission to edit this workspace.`);
  }
});

// Update Workspace Form Action
workspaceDialog.querySelector("form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const title = document.getElementById("workspace-title-input").value.trim();
  const authorName = document.getElementById("workspace-author-input").value.trim();
  
  if (!title) return;
  
  try {
    await updateDoc(doc(db, "workspaces", activeWorkspaceId), {
      title: title,
      authorName: authorName
    });
    workspaceDialog.close();
  } catch (error) {
    console.error("Update workspace error:", error);
  }
});

// Sharing settings toggle
document.getElementById("share-toggle").addEventListener("change", async (e) => {
  const isPublic = e.target.checked;
  try {
    await updateDoc(doc(db, "workspaces", activeWorkspaceId), {
      sharing: isPublic ? "public" : "private"
    });
  } catch (error) {
    console.error("Update sharing status error:", error);
    e.target.checked = !isPublic; // Reset toggle
  }
});

// Copy share link button
document.getElementById("copy-link-btn").addEventListener("click", () => {
  const linkInput = document.getElementById("share-link-input");
  linkInput.select();
  document.execCommand("copy");
  
  const copyBtn = document.getElementById("copy-link-btn");
  copyBtn.textContent = "Copied!";
  setTimeout(() => {
    copyBtn.textContent = "Copy";
  }, 2000);
});

// Show floating right-click context menu
function showContextMenu(itemId, clientX, clientY) {
  contextMenuTargetId = itemId;
  
  // Enforce context options depending on target item type (e.g. Add Link only for folders)
  const item = workspaceItems[itemId];
  const addLinkBtn = document.getElementById("ctx-add-link");
  if (addLinkBtn) {
    if (item && item.type === "folder") {
      addLinkBtn.classList.remove("hidden");
    } else {
      addLinkBtn.classList.add("hidden");
    }
  }
  
  contextMenu.style.position = "fixed";
  contextMenu.style.top = `${clientY}px`;
  contextMenu.style.left = `${clientX}px`;
  
  contextMenu.showPopover();
}

// Add Link from Context Menu
document.getElementById("ctx-add-link").addEventListener("click", () => {
  contextMenu.hidePopover();
  const folder = workspaceItems[contextMenuTargetId];
  if (!folder) return;
  
  linkDialogParentId = folder.id;
  document.getElementById("link-dialog-title").textContent = `Add Link in ${folder.title}`;
  document.getElementById("link-url-input").value = "";
  document.getElementById("link-title-input").value = "";
  linkDialog.showModal();
});

// Rename selected item
document.getElementById("ctx-rename").addEventListener("click", () => {
  contextMenu.hidePopover();
  const item = workspaceItems[contextMenuTargetId];
  if (!item) return;
  
  const newName = prompt(`Rename ${item.type}:`, item.title);
  if (newName !== null && newName.trim() !== "") {
    updateDoc(doc(db, "workspaces", activeWorkspaceId, "items", contextMenuTargetId), {
      title: newName.trim()
    });
  }
});

// Delete selected item
document.getElementById("ctx-delete").addEventListener("click", async () => {
  contextMenu.hidePopover();
  const item = workspaceItems[contextMenuTargetId];
  if (!item) return;
  
  if (confirm(`Are you sure you want to delete this ${item.type}?`)) {
    const batch = writeBatch(db);
    
    // Delete item doc
    batch.delete(doc(db, "workspaces", activeWorkspaceId, "items", contextMenuTargetId));
    
    // Remove from parent's childrenIds array
    const parentId = item.parentId;
    if (parentId === "root") {
      const filteredRoot = (activeWorkspace.childrenIds || []).filter(id => id !== contextMenuTargetId);
      batch.update(doc(db, "workspaces", activeWorkspaceId), {
        childrenIds: filteredRoot
      });
    } else {
      const parentDoc = workspaceItems[parentId];
      if (parentDoc) {
        const filteredChildren = (parentDoc.childrenIds || []).filter(id => id !== contextMenuTargetId);
        batch.update(doc(db, "workspaces", activeWorkspaceId, "items", parentId), {
          childrenIds: filteredChildren
        });
      }
    }
    
    // If it was a folder, orphan its immediate children to root
    if (item.type === "folder" && item.childrenIds) {
      const currentRootChildren = [...(activeWorkspace.childrenIds || [])];
      item.childrenIds.forEach(childId => {
        const childDoc = workspaceItems[childId];
        if (childDoc) {
          batch.update(doc(db, "workspaces", activeWorkspaceId, "items", childId), {
            parentId: "root"
          });
          currentRootChildren.push(childId);
        }
      });
      batch.update(doc(db, "workspaces", activeWorkspaceId), {
        childrenIds: currentRootChildren
      });
    }
    
    try {
      await batch.commit();
      
      // If we deleted the active select, revert layout
      if (selectedItemId === contextMenuTargetId) {
        selectedItemId = null;
        showEmptyState("Welcome to Link-Folders", "Select folders or URLs inside the sidebar.");
      }
    } catch (err) {
      console.error("Delete operation failed:", err);
    }
  }
});

// Google Authentication Sign-In Linking
document.getElementById("google-login-btn").addEventListener("click", async () => {
  const provider = new GoogleAuthProvider();
  try {
    if (auth.currentUser && auth.currentUser.isAnonymous) {
      // Correct flow: link the current anonymous user in place to preserve ownership of local workspaces
      await linkWithPopup(auth.currentUser, provider);
      console.log("Successfully linked anonymous account with Google!");
    } else {
      // Fallback: normal sign in
      await signInWithPopup(auth, provider);
    }
    accountDialog.close();
  } catch (error) {
    console.error("Authentication integration error:", error);
    alert(`Authentication failed: ${error.message}`);
  }
});

document.getElementById("sign-out-btn").addEventListener("click", async () => {
  if (confirm("Are you sure you want to sign out?")) {
    try {
      await signOut(auth);
      accountDialog.close();
      window.location.reload();
    } catch (error) {
      console.error("Sign out error:", error);
    }
  }
});

// Helper UI update functions
function updateAccountUI() {
  const accountBtnLabel = document.getElementById("account-btn-label");
  const accountAnonSection = document.getElementById("account-anonymous");
  const accountLoggedInSection = document.getElementById("account-logged-in");
  const userPhoto = document.getElementById("user-photo");
  const userName = document.getElementById("user-name");
  const userEmail = document.getElementById("user-email");
  
  if (currentUser.isAnonymous) {
    accountBtnLabel.textContent = "Sign In";
    accountAnonSection.classList.remove("hidden");
    accountLoggedInSection.classList.add("hidden");
  } else {
    // Show display name, fallback to username of email, fallback to "Account"
    accountBtnLabel.textContent = currentUser.displayName || (currentUser.email ? currentUser.email.split('@')[0] : "Account");
    accountAnonSection.classList.add("hidden");
    accountLoggedInSection.classList.remove("hidden");
    
    userName.textContent = currentUser.displayName || (currentUser.email ? currentUser.email.split('@')[0] : "Google Account");
    userEmail.textContent = currentUser.email || "No email available";
    
    if (currentUser.photoURL) {
      userPhoto.src = currentUser.photoURL;
      userPhoto.classList.remove("hidden");
    } else {
      userPhoto.classList.add("hidden");
    }
  }
}

function updateSidebarFooterUI(isOwner) {
  const footerActions = document.querySelector(".footer-actions");
  const renameBtn = document.getElementById("rename-workspace-btn");
  
  if (isOwner) {
    footerActions.classList.remove("hidden");
    renameBtn.classList.remove("hidden");
    const cloneBanner = document.getElementById("clone-banner");
    if (cloneBanner) cloneBanner.remove();
  } else {
    footerActions.classList.add("hidden");
    renameBtn.classList.add("hidden");
    
    // Add banner or button for visitor cloning
    let cloneBanner = document.getElementById("clone-banner");
    if (!cloneBanner) {
      cloneBanner = document.createElement("div");
      cloneBanner.id = "clone-banner";
      cloneBanner.className = "clone-banner-overlay";
      
      const cloneBtn = document.createElement("button");
      cloneBtn.className = "action-btn-primary clone-btn";
      cloneBtn.textContent = "Clone to My Folders";
      cloneBtn.addEventListener("click", cloneActiveSharedWorkspace);
      
      cloneBanner.appendChild(cloneBtn);
      document.querySelector(".sidebar").appendChild(cloneBanner);
    }
  }
}

// Clone shared workspace into current user's library
async function cloneActiveSharedWorkspace() {
  if (!activeWorkspace) return;
  const cloneBtn = document.querySelector(".clone-btn");
  cloneBtn.textContent = "Cloning...";
  cloneBtn.disabled = true;
  
  try {
    const newWsId = generateUUID();
    
    // Create new workspace owned by visitor
    const newWsDoc = {
      id: newWsId,
      ownerId: currentUser.uid,
      title: `${activeWorkspace.title} (cloned)`,
      authorName: currentUser.displayName || "guest",
      sharing: "private",
      childrenIds: activeWorkspace.childrenIds || [],
      createdAt: serverTimestamp()
    };
    
    await setDoc(doc(db, "workspaces", newWsId), newWsDoc);
    
    // Clone all items in subcollection
    const batch = writeBatch(db);
    Object.values(workspaceItems).forEach(item => {
      const clonedItem = { ...item };
      batch.set(doc(db, "workspaces", newWsId, "items", item.id), clonedItem);
    });
    
    await batch.commit();
    
    // Redirect to normal view of the cloned workspace
    alert("Workspace successfully cloned!");
    window.location.search = ""; // Clears the share URL queries
    localStorage.setItem(`lf_active_ws_${currentUser.uid}`, newWsId);
  } catch (error) {
    console.error("Clone shared workspace error:", error);
    alert(`Failed to clone: ${error.message}`);
    cloneBtn.textContent = "Clone to My Folders";
    cloneBtn.disabled = false;
  }
}

// Utility Helper functions
function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    var r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

function getDomain(url) {
  if (!url) return "";
  try {
    const parsed = new URL(url);
    return parsed.hostname;
  } catch (e) {
    try {
      const parsed = new URL(`http://${url}`);
      return parsed.hostname;
    } catch (e2) {
      return url;
    }
  }
}

function isDescendantOf(draggedId, targetId) {
  let currentId = targetId;
  while (currentId && currentId !== "root") {
    if (currentId === draggedId) return true;
    const parentDoc = workspaceItems[currentId];
    currentId = parentDoc ? parentDoc.parentId : null;
  }
  return false;
}

// Paste link directly inside selected folder
window.addEventListener("paste", async (e) => {
  // If we are actively typing in an input/textarea, let the default paste happen
  if (document.activeElement.tagName === "INPUT" || document.activeElement.tagName === "TEXTAREA") {
    return;
  }
  
  if (!selectedItemId || !activeWorkspaceId) return;
  
  const targetFolder = workspaceItems[selectedItemId];
  if (!targetFolder || targetFolder.type !== "folder") return;
  
  const pastedText = e.clipboardData.getData("text")?.trim();
  if (!pastedText) return;
  
  // Validate if the pasted text is a URL
  const urlRegex = /^(https?:\/\/)?([\da-z\.-]+)\.([a-z\.]{2,6})([\/\w \.-]*)*\/?$/i;
  if (!urlRegex.test(pastedText)) {
    return; // Not a URL, ignore
  }
  
  e.preventDefault();
  
  let url = pastedText;
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    url = "https://" + url;
  }
  
  const title = getDomain(url);
  
  try {
    const linkId = generateUUID();
    const linkDoc = {
      id: linkId,
      parentId: targetFolder.id,
      type: "link",
      title: title,
      url: url,
      createdAt: Date.now()
    };
    
    const batch = writeBatch(db);
    batch.set(doc(db, "workspaces", activeWorkspaceId, "items", linkId), linkDoc);
    
    const currentFolderChildren = [...(targetFolder.childrenIds || []), linkId];
    batch.update(doc(db, "workspaces", activeWorkspaceId, "items", targetFolder.id), {
      childrenIds: currentFolderChildren
    });
    
    await batch.commit();
    console.log(`Pasted link successfully inside folder ${targetFolder.title}`);
  } catch (error) {
    console.error("Paste link error:", error);
    alert(`Failed to paste link: ${error.message}`);
  }
});
