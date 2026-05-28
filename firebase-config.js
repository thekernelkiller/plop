import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

// TODO: Replace this configuration object with your actual Firebase web app configuration.
const firebaseConfig = {
  apiKey: "AIzaSyCBtf8VOGOaL08ZHuFFXVHVZfNYqLJhlJo",
  authDomain: "link-folders-50581.firebaseapp.com",
  projectId: "link-folders-50581",
  storageBucket: "link-folders-50581.firebasestorage.app",
  messagingSenderId: "1013706270678",
  appId: "1:1013706270678:web:ad86edce5cca94d84a2677",
  measurementId: "G-Q74B73T56J",
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

export { auth, db };
