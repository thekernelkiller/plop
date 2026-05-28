import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

// Fetch and parse the local .env file at runtime (no build step required)
let firebaseConfig = {};

try {
  const response = await fetch("./.env");
  if (!response.ok) {
    throw new Error(`Failed to load .env file: status ${response.status}`);
  }
  const text = await response.text();
  text.split("\n").forEach(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return; // Skip comments and empty lines
    const parts = trimmed.split("=");
    if (parts.length >= 2) {
      const key = parts[0].trim();
      // Parse values with '=' inside them (like URLs or base64)
      const value = parts.slice(1).join("=").trim().replace(/['"]/g, "");
      
      // Map FIREBASE_ prefix to config camelCase keys
      if (key === "FIREBASE_API_KEY") firebaseConfig.apiKey = value;
      else if (key === "FIREBASE_AUTH_DOMAIN") firebaseConfig.authDomain = value;
      else if (key === "FIREBASE_PROJECT_ID") firebaseConfig.projectId = value;
      else if (key === "FIREBASE_STORAGE_BUCKET") firebaseConfig.storageBucket = value;
      else if (key === "FIREBASE_MESSAGING_SENDER_ID") firebaseConfig.messagingSenderId = value;
      else if (key === "FIREBASE_APP_ID") firebaseConfig.appId = value;
      else if (key === "FIREBASE_MEASUREMENT_ID") firebaseConfig.measurementId = value;
    }
  });
} catch (error) {
  console.error("Firebase Configuration Error: Could not parse local .env file.", error);
}

if (!firebaseConfig.apiKey) {
  console.error("Firebase API Key is missing. Please check your local .env configuration.");
}

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

export { auth, db };
