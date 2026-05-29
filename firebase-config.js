import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

// Fetch and parse the local configuration at runtime (tries env.json first, then .env locally)
let firebaseConfig = {};

try {
  let response = await fetch("./env.json");
  if (response.ok) {
    const config = await response.json();
    firebaseConfig = {
      apiKey:            config.FIREBASE_API_KEY,
      authDomain:        config.FIREBASE_AUTH_DOMAIN,
      projectId:         config.FIREBASE_PROJECT_ID,
      storageBucket:     config.FIREBASE_STORAGE_BUCKET,
      messagingSenderId: config.FIREBASE_MESSAGING_SENDER_ID,
      appId:             config.FIREBASE_APP_ID,
      measurementId:     config.FIREBASE_MEASUREMENT_ID
    };
  } else {
    // Fallback: parse raw .env file for local development
    response = await fetch("./.env");
    if (!response.ok) {
      throw new Error(`Failed to fetch either env.json or .env: status ${response.status}`);
    }
    const text = await response.text();
    text.split("\n").forEach(line => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return; // Skip comments and empty lines
      const parts = trimmed.split("=");
      if (parts.length >= 2) {
        const key = parts[0].trim();
        const value = parts.slice(1).join("=").trim().replace(/['"]/g, "");
        
        if (key === "FIREBASE_API_KEY") firebaseConfig.apiKey = value;
        else if (key === "FIREBASE_AUTH_DOMAIN") firebaseConfig.authDomain = value;
        else if (key === "FIREBASE_PROJECT_ID") firebaseConfig.projectId = value;
        else if (key === "FIREBASE_STORAGE_BUCKET") firebaseConfig.storageBucket = value;
        else if (key === "FIREBASE_MESSAGING_SENDER_ID") firebaseConfig.messagingSenderId = value;
        else if (key === "FIREBASE_APP_ID") firebaseConfig.appId = value;
        else if (key === "FIREBASE_MEASUREMENT_ID") firebaseConfig.measurementId = value;
      }
    });
  }
} catch (error) {
  console.error("Firebase Configuration Error: Could not parse environment variables.", error);
}

if (!firebaseConfig.apiKey) {
  console.error("Firebase API Key is missing. Please check your local .env configuration.");
}

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

export { auth, db };
