// src/firebase.js
import { initializeApp } from "firebase/app";
import { getAuth, GoogleAuthProvider } from "firebase/auth";
import { getFirestore } from "firebase/firestore";

// Your web app's Firebase configuration
const firebaseConfig = {
  apiKey: "AIzaSyAWJlh8-75ku0gI3cTZLQx3H4Nv5LmIPGM",
  authDomain: "clipbook-35791.firebaseapp.com",
  projectId: "clipbook-35791",
  storageBucket: "clipbook-35791.firebasestorage.app",
  messagingSenderId: "598659545531",
  appId: "1:598659545531:web:9ccf932450d3a55584ec9e"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);

// ✅ Exports for use in other files
export const auth = getAuth(app);
export const provider = new GoogleAuthProvider();
export const db = getFirestore(app);
