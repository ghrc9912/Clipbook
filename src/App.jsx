// src/App.jsx
import { useEffect, useState } from "react";
import { onAuthStateChanged } from "firebase/auth";
import { auth } from "./firebase";
import Login from "./Login";
import Dashboard from "./Dashboard";

export default function App() {

  // 🔍 Debug line: Checks whether .env variables are loaded correctly by Vite
  console.log("HF_KEY (Vite) =", import.meta.env.VITE_HF_KEY);

  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => {
      setUser(u);
      setLoading(false);
    });
    return unsub;
  }, []);

  if (loading) {
    return <div style={{ padding: 20 }}>Loading…</div>;
  }

  return user ? <Dashboard /> : <Login setUser={setUser} />;
}
