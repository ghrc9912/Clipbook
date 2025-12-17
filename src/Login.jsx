// src/Login.jsx
import React from "react";
import { GoogleAuthProvider, signInWithPopup, OAuthProvider } from "firebase/auth";
import { auth } from "./firebase";
import logo from "./assets/img/logo.png";
import bgImg from "./assets/img/login-bg.png";

/*
  This Login component:
   - draws a full-bleed background image (bgImg)
   - draws an overlay-layer DOM element for the animated color wash
   - shows a floating glassy logo badge centered at the top
   - shows a translucent glass sign-in card centered on the page (no logo inside)
   - provides polished branded sign-in buttons (Google + Microsoft)
   - uses inline SVG data-uris for crisp icons
*/

export default function Login() {
  // Google sign-in
  const signInWithGoogle = async () => {
    try {
      const provider = new GoogleAuthProvider();
      provider.setCustomParameters({ prompt: "select_account" });
      await signInWithPopup(auth, provider);
    } catch (err) {
      console.error("Google sign-in failed:", err);
      alert("Google sign-in failed: " + (err.message || err));
    }
  };

  // Microsoft sign-in
  const signInWithMicrosoft = async () => {
    try {
      const provider = new OAuthProvider("microsoft.com");
      provider.setCustomParameters({ prompt: "select_account" });
      provider.addScope("openid");
      provider.addScope("profile");
      provider.addScope("email");
      await signInWithPopup(auth, provider);
    } catch (err) {
      console.error("Microsoft sign-in failed:", err);
      if (err.code === "auth/popup-closed-by-user") {
        alert("Popup closed before completing sign-in. Try again.");
      } else if (err.message && err.message.includes("consent_required")) {
        alert("Consent required. Admin may need to grant consent in Azure AD.");
      } else {
        alert("Microsoft sign-in failed: " + (err.message || err));
      }
    }
  };

  // inline SVG icons as data URIs (crisp)
  const googleSvg =
    'data:image/svg+xml;utf8,' +
    encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 46 46"><defs/><g fill="none" fill-rule="evenodd"><path d="M23 9c3.867 0 6.7 1.67 8.69 3.072l6.308-6.07C33.74 2.06 28.85 0 23 0 13.8 0 5.99 4.71 1.97 11.56l7.34 5.697C11.9 12.02 17.99 9 23 9z" fill="#EA4335"/><path d="M45.9 23.5c0-1.33-.13-2.48-.36-3.58H23v6.78h12.98c-.55 3.06-3.2 7.52-9.28 9.89l.01.07 7.43 5.78c4.35-4.05 7.76-9.9 7.76-18.94z" fill="#4285F4"/><path d="M8.02 27.25A13.9 13.9 0 0 1 6.3 23c0-1.58.27-3.1.76-4.5l-7.34-5.7C.25 13.25 0 17.04 0 23c0 5.98.22 9.59 7.34 14.94l.68-.69z" fill="#FBBC05"/><path d="M23 46c6.1 0 11.44-2 15.14-5.45l-7.43-5.78C28.98 35.45 26 36 23 36c-6 0-11.15-3.8-13.3-9.31l-7.34 5.7C5.98 41.29 13.8 46 23 46z" fill="#34A853"/></g></svg>`
    );

  const msSvg =
    'data:image/svg+xml;utf8,' +
    encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect x="1" y="1" width="10.5" height="10.5" fill="#F25022"/><rect x="12.5" y="1" width="10.5" height="10.5" fill="#7FBA00"/><rect x="1" y="12.5" width="10.5" height="10.5" fill="#00A4EF"/><rect x="12.5" y="12.5" width="10.5" height="10.5" fill="#FFB900"/></svg>`
    );

  return (
    <div className="app-shell">
      {/* Background image (image injected via inline style) */}
      <div
        className="app-bg"
        aria-hidden="true"
        style={{ backgroundImage: `url(${bgImg})` }}
      />

      {/* Overlay layer (real DOM element — guaranteed to render above .app-bg) */}
      <div className="overlay-layer" aria-hidden="true" />

      {/* Floating top-center logo badge */}
      <div className="top-logo-badge" aria-hidden="true">
        <div className="top-logo-inner">
          <img src={logo} alt="ClipBook" />
        </div>
      </div>

      {/* Sign-in Card */}
      <div className="theme-card" role="region" aria-label="ClipBook sign in">
        {/* Left: Brand text (logo removed from card) */}
        <div className="brand-block">
          <div style={{ width: 64, height: 64 }} /> {/* spacer to keep layout */}
          <div>
            <div className="brand-title">ClipBook</div>
            <div className="brand-sub">Video Library Manager</div>
          </div>
        </div>

        {/* Sign-in section */}
        <div className="signin-area">
          <div style={{ maxWidth: 520 }}>
            <h2 style={{ margin: 0 }}>Sign in to ClipBook</h2>
            <p style={{ marginTop: 8, marginBottom: 8, color: "rgba(11,18,32,0.72)" }}>
               Sign in with Google or Microsoft to save and manage your clips.
            </p>
          </div>

          <div className="signin-buttons">
            <button className="btn-google" onClick={signInWithGoogle}>
              <img src={googleSvg} alt="Google" className="btn-icon" />
              Sign in with Google
            </button>

            <button className="btn-microsoft" onClick={signInWithMicrosoft}>
              <img src={msSvg} alt="Microsoft" className="btn-icon" />
              Sign in with Microsoft
            </button>
          </div>

          <div className="signin-tip" style={{ marginTop: 8 }}>
            Tip: If sign-in fails, try an incognito window (clears old sessions) and check popup blockers.
          </div>
        </div>
      </div>
    </div>
  );
}
